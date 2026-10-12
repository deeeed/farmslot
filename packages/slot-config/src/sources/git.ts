import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  canonicalSourceJson,
  canonicalSourceRepo,
  isContainedSourceEntry,
  type SourceDeclaration,
} from '@farmslot/protocol';

const execute = promisify(execFile);

export type SourceCommand = (program: string, args: string[]) => Promise<Buffer>;

export const sourceCommand: SourceCommand = async (program, args) => {
  const result = await execute(program, args, {
    encoding: 'buffer',
    timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'https:ssh' },
  });
  return result.stdout;
};

export interface SourceTreeFile {
  path: string;
  mode: '100644' | '100755' | '120000';
  object: string;
}

export interface FetchedSource {
  commit: string;
  objectFormat: 'sha1' | 'sha256';
  refKind: 'branch' | 'tag' | 'commit';
  refObject: string;
  files: SourceTreeFile[];
  treeDigest: string;
}

export function sourceDigest(value: unknown): string {
  return createHash('sha256').update(canonicalSourceJson(value)).digest('hex');
}

/** One repository cache per canonical identity. No checkout, hooks or install scripts. */
export class SourceGitStore {
  constructor(
    readonly cacheRoot: string,
    private readonly command: SourceCommand = sourceCommand,
  ) {}

  repository(repo: string): string {
    return path.join(this.cacheRoot, 'objects', sourceDigest(canonicalSourceRepo(repo)));
  }

  async git(repo: string, args: string[]): Promise<Buffer> {
    return this.command('git', [
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'submodule.recurse=false',
      '-c',
      'fetch.recurseSubmodules=false',
      '--git-dir',
      this.repository(repo),
      ...args,
    ]);
  }

  private async initialize(repo: string, objectFormat: string): Promise<void> {
    const root = this.repository(repo);
    await mkdir(root, { recursive: true });
    await this.command('git', [
      '-c',
      'core.hooksPath=/dev/null',
      'init',
      '--bare',
      `--object-format=${objectFormat}`,
      root,
    ]);
    const format = (await this.git(repo, ['rev-parse', '--show-object-format'])).toString().trim();
    if (format !== objectFormat) throw new Error('Source repository object format changed');
  }

  async resolve(source: SourceDeclaration, ref = source.ref ?? 'main'): Promise<FetchedSource> {
    const repo = canonicalSourceRepo(source.repo);
    if (!ref || ref.startsWith('-') || /[\s\x00-\x1f]/.test(ref))
      throw new Error('Invalid source ref');
    let object: string;
    let target: string;
    let refKind: FetchedSource['refKind'];
    if (/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(ref)) {
      object = ref;
      target = ref;
      refKind = 'commit';
    } else {
      const rows = (await this.command('git', ['ls-remote', '--heads', '--tags', repo]))
        .toString()
        .trim()
        .split('\n');
      const branch = ref.startsWith('refs/') ? ref : `refs/heads/${ref}`;
      const tag = ref.startsWith('refs/') ? ref : `refs/tags/${ref}`;
      const selected =
        rows.find((row) => row.split('\t')[1] === branch) ??
        rows.find((row) => row.split('\t')[1] === tag);
      if (!selected) throw new Error(`Source ${source.id} ref is missing: ${ref}`);
      [object, target] = selected.split('\t');
      refKind = target.startsWith('refs/heads/') ? 'branch' : 'tag';
    }
    const objectFormat = object.length === 64 ? 'sha256' : 'sha1';
    await this.initialize(repo, objectFormat);
    await this.git(repo, ['fetch', '--no-tags', '--no-write-fetch-head', repo, object]);
    const commit = (await this.git(repo, ['rev-parse', '--verify', `${object}^{commit}`]))
      .toString()
      .trim();
    const fetched = await this.inspect(repo, commit);
    return { ...fetched, refKind, refObject: object };
  }

  /** Exact old locks use retained objects, fetching that object only when absent. */
  async retain(
    repo: string,
    commit: string,
    objectFormat: 'sha1' | 'sha256',
  ): Promise<FetchedSource> {
    canonicalSourceRepo(repo);
    if (!(objectFormat === 'sha1' ? /^[0-9a-f]{40}$/ : /^[0-9a-f]{64}$/).test(commit))
      throw new Error('Invalid locked Git object');
    await this.initialize(repo, objectFormat);
    try {
      return { ...(await this.inspect(repo, commit)), refKind: 'commit', refObject: commit };
    } catch (error) {
      // Missing retained objects may be fetched only by their exact locked ID.
      if ((error as { code?: string | number }).code !== 128) throw error;
    }
    // Fetching only the locked object never follows a node-side branch.
    await this.git(repo, ['fetch', '--no-tags', '--no-write-fetch-head', repo, commit]);
    return { ...(await this.inspect(repo, commit)), refKind: 'commit', refObject: commit };
  }

  async inspect(
    repo: string,
    commit: string,
  ): Promise<Omit<FetchedSource, 'refKind' | 'refObject'>> {
    const objectFormat = (await this.git(repo, ['rev-parse', '--show-object-format']))
      .toString()
      .trim();
    if (objectFormat !== 'sha1' && objectFormat !== 'sha256')
      throw new Error('Unsupported Git object format');
    const raw = (await this.git(repo, ['ls-tree', '-rz', '--full-tree', commit])).toString();
    const files: SourceTreeFile[] = raw
      .split('\0')
      .filter(Boolean)
      .map((record) => {
        const match = /^(100644|100755|120000) blob ([0-9a-f]+)\t(.+)$/.exec(record);
        if (!match || !isContainedSourceEntry(match[3]) || match[3].split('/').includes('.git'))
          throw new Error('Unsupported submodule, external object or unsafe source tree entry');
        return { mode: match[1] as SourceTreeFile['mode'], object: match[2], path: match[3] };
      });
    for (const file of files.filter((entry) => /(^|\/)\.gitattributes$/.test(entry.path))) {
      const attributes = (await this.blob(repo, file.object)).toString();
      if (/filter\s*=\s*lfs/.test(attributes))
        throw new Error('LFS source objects require declared, verified dependencies');
    }
    await this.git(repo, ['update-ref', `refs/sources/${commit}`, commit]);
    return { commit, objectFormat, files, treeDigest: sourceDigest(files) };
  }

  async blob(repo: string, object: string): Promise<Buffer> {
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(object)) throw new Error('Invalid blob object');
    return this.git(repo, ['cat-file', 'blob', object]);
  }

  async readJson(repo: string, tree: FetchedSource, entry: string): Promise<unknown | undefined> {
    if (!isContainedSourceEntry(entry)) throw new Error('Source manifest entry escapes its source');
    const file = tree.files.find((value) => value.path === entry);
    if (!file) return undefined;
    if (file.mode === '120000') throw new Error('Source manifests cannot be symlinks');
    return JSON.parse((await this.blob(repo, file.object)).toString());
  }

  async export(repo: string, tree: FetchedSource, root: string): Promise<void> {
    for (const file of tree.files) {
      const target = path.join(root, file.path);
      await mkdir(path.dirname(target), { recursive: true });
      const content = await this.blob(repo, file.object);
      if (file.mode === '120000') {
        const link = content.toString();
        const relative = path.relative(root, path.resolve(path.dirname(target), link));
        if (path.isAbsolute(link) || relative === '..' || relative.startsWith('../'))
          throw new Error(`Source symlink escapes its tree: ${file.path}`);
        await symlink(link, target);
      } else
        await writeFile(target, content, {
          flag: 'wx',
          mode: file.mode === '100755' ? 0o755 : 0o644,
        });
    }
  }
}
