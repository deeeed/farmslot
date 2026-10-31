import { copyFile, lstat, mkdir, rm, stat, utimes } from 'node:fs/promises';
import path from 'node:path';

import type { NativeTurnChanges, NativeTurnFile } from '@farmslot/protocol';

import { git } from './workspace.js';

/** Hidden refs under which a session's checkpoints stay reachable, one ref per checkpoint. */
const REF_ROOT = 'refs/farmslot/native';
/** Checkpoints a session keeps; older refs are deleted, so their diffs are no longer retained. */
export const NATIVE_CHECKPOINTS_KEPT = 100;
/** Files a turn lists; more set `truncated`. */
const TURN_FILES_LIMIT = 500;
/** Untracked files larger than this stay out of checkpoints, so build output is never hashed. */
export const NATIVE_CHECKPOINT_UNTRACKED_LIMIT = 10 * 1024 * 1024;
const IDENTITY = {
  GIT_AUTHOR_NAME: 'Farmslot',
  GIT_AUTHOR_EMAIL: 'farmslot@localhost',
  GIT_COMMITTER_NAME: 'Farmslot',
  GIT_COMMITTER_EMAIL: 'farmslot@localhost',
};

const refPrefix = (sessionId: string) => `${REF_ROOT}/${sessionId}`;

/**
 * A session's checkpoints: commits of its Git working tree's content, untracked files Git does not
 * ignore included, with `HEAD` as parent. They are built in the session's own index, seeded from
 * the worktree's index and reseeded only when that changes, so Git's stat cache hashes only files
 * changed since the previous checkpoint, tracked or not. The worktree, its index, `HEAD` and every
 * branch stay untouched. One Git call per step, never one per file; steps run one at a time.
 */
export class NativeCheckpoints {
  private last?: { commit: string; tree: string };
  /** The worktree index the session's index was seeded from. */
  private seeded?: string;
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly root: string,
    private readonly gitDir: string,
    private readonly prefix: string,
    private refs: string[],
    private readonly kept: number,
    private readonly indexDir: string,
  ) {}

  /**
   * Checkpoints for a session whose working directory is in a Git working tree, or none.
   * `indexDir` holds the session's index; `remove` deletes it with the refs.
   */
  static async open(
    cwd: string,
    sessionId: string,
    options: { indexDir: string; kept?: number },
  ): Promise<NativeCheckpoints | undefined> {
    const located = await git(cwd, ['rev-parse', '--show-toplevel', '--absolute-git-dir']).catch(
      () => undefined,
    );
    if (!located) return undefined;
    const [root, gitDir] = located.trim().split('\n');
    const prefix = refPrefix(sessionId);
    const refs = (await git(root, ['for-each-ref', '--format=%(refname)', `${prefix}/`]))
      .split('\n')
      .filter(Boolean)
      .sort();
    const { indexDir } = options;
    await mkdir(indexDir, { recursive: true, mode: 0o700 });
    return new NativeCheckpoints(
      root,
      gitDir,
      prefix,
      refs,
      options.kept ?? NATIVE_CHECKPOINTS_KEPT,
      indexDir,
    );
  }

  private serial<T>(step: () => Promise<T>): Promise<T> {
    const done = this.queue.then(step);
    this.queue = done.catch(() => undefined);
    return done;
  }

  /** The working tree now; the previous checkpoint when nothing changed since it. */
  take(): Promise<string> {
    return this.serial(() => this.snapshot());
  }

  private async snapshot(): Promise<string> {
    const index = path.join(this.indexDir, 'index');
    await this.seed(index);
    const env = { GIT_INDEX_FILE: index };
    // Entries the session's index holds: changed ones are hashed, deleted ones dropped.
    await git(this.root, ['add', '--update', '--', '.'], undefined, env);
    const untracked = await this.untracked(env);
    // A file removed since it was listed is skipped, not an error.
    if (untracked.length)
      await git(
        this.root,
        ['update-index', '--add', '--remove', '-z', '--stdin'],
        undefined,
        env,
        `${untracked.join('\0')}\0`,
      );
    const tree = (await git(this.root, ['write-tree'], undefined, env)).trim();
    if (this.last?.tree === tree) return this.last.commit;
    const message = ['-m', 'Farmslot native checkpoint'];
    const commit = (
      await git(this.root, ['commit-tree', tree, '-p', 'HEAD', ...message], undefined, IDENTITY)
        // An unborn branch has no HEAD to descend from.
        .catch(() => git(this.root, ['commit-tree', tree, ...message], undefined, IDENTITY))
    ).trim();
    const ref = `${this.prefix}/${Date.now().toString(36).padStart(9, '0')}-${commit.slice(0, 12)}`;
    const stale = this.refs.length + 1 - this.kept;
    const expired = stale > 0 ? this.refs.slice(0, stale) : [];
    // One transaction: the new ref, and the oldest beyond those kept.
    await this.updateRefs([`create ${ref} ${commit}`, ...expired.map((old) => `delete ${old}`)]);
    this.refs = [...this.refs.slice(expired.length), ref];
    this.last = { commit, tree };
    return commit;
  }

  /**
   * Seeds the session's index from the worktree's when that changed (a commit, a staged file, a
   * checkout) or none exists yet. The copy keeps the original's timestamp, so Git still re-checks
   * entries written in the same second as that index.
   */
  private async seed(index: string): Promise<void> {
    const source = path.join(this.gitDir, 'index');
    const current = await stat(source).catch(() => undefined);
    const key = current && `${current.ino}:${current.size}:${current.mtimeMs}`;
    if (key === this.seeded && (await stat(index).catch(() => undefined))) return;
    if (current) {
      await copyFile(source, index);
      await utimes(index, current.atime, current.mtime);
    } else await rm(index, { force: true });
    this.seeded = key;
  }

  /** Files the session's index lacks that Git does not ignore, up to the size limit each. */
  private async untracked(env: Record<string, string>): Promise<string[]> {
    const listed = await git(
      this.root,
      ['ls-files', '--others', '--exclude-standard', '-z'],
      8 * 1024 * 1024,
      env,
    );
    const files: string[] = [];
    for (const file of listed.split('\0')) {
      if (!file || file.endsWith('/')) continue;
      const entry = await lstat(path.join(this.root, file)).catch(() => undefined);
      if (
        entry?.isSymbolicLink() ||
        (entry?.isFile() && entry.size <= NATIVE_CHECKPOINT_UNTRACKED_LIMIT)
      )
        files.push(file);
    }
    return files;
  }

  /** The files that differ between two checkpoints, from one tree-to-tree diff. */
  async changes(from: string, to: string): Promise<NativeTurnChanges> {
    if (from === to) return { from, to, files: [] };
    const output = await git(
      this.root,
      ['diff-tree', '-r', '-z', '--no-renames', '--no-ext-diff', '--raw', '--numstat', from, to],
      8 * 1024 * 1024,
    );
    const files = parseTurnFiles(output);
    return {
      from,
      to,
      files: files.slice(0, TURN_FILES_LIMIT),
      ...(files.length > TURN_FILES_LIMIT ? { truncated: true } : {}),
    };
  }

  /** Deletes the session's checkpoint refs and index; their diffs are no longer retained. */
  remove(): Promise<void> {
    return this.serial(async () => {
      if (this.refs.length) await this.updateRefs(this.refs.map((ref) => `delete ${ref}`));
      this.refs = [];
      this.last = undefined;
      this.seeded = undefined;
      await rm(this.indexDir, { recursive: true, force: true });
    });
  }

  private async updateRefs(lines: string[]): Promise<void> {
    await git(
      this.root,
      ['update-ref', '--stdin'],
      undefined,
      {},
      `start\n${lines.join('\n')}\nprepare\ncommit\n`,
    );
  }
}

/** `diff-tree -z --raw --numstat`: raw records first (`:modes shas status\0path\0`), then counts. */
export function parseTurnFiles(output: string): NativeTurnFile[] {
  const tokens = output.split('\0');
  const files = new Map<string, NativeTurnFile>();
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.startsWith(':')) {
      const status = token.split(' ').at(-1);
      const file = tokens[++i];
      files.set(file, {
        path: file,
        status: status === 'A' ? 'added' : status === 'D' ? 'deleted' : 'modified',
      });
    } else if (token.includes('\t')) {
      // A path may itself hold tabs.
      const [additions, deletions, ...name] = token.split('\t');
      const entry = files.get(name.join('\t'));
      if (entry && additions !== '-') {
        entry.additions = Number(additions);
        entry.deletions = Number(deletions);
      }
    }
  }
  return [...files.values()];
}

/**
 * One file's diff between two checkpoints of the session's repository; `file` is relative to its
 * root. `undefined` once either checkpoint is no longer retained under the session's refs.
 */
export async function nativeTurnDiff(
  cwd: string,
  sessionId: string,
  from: string,
  to: string,
  file: string,
): Promise<string | undefined> {
  const [root, retained] = await Promise.all([
    git(cwd, ['rev-parse', '--show-toplevel']),
    git(cwd, ['for-each-ref', '--format=%(objectname)', `${refPrefix(sessionId)}/`]),
  ]);
  const kept = new Set(retained.split('\n'));
  if (!kept.has(from) || !kept.has(to)) return undefined;
  // Pathspecs are literal and relative to where Git runs, so run at the root.
  return git(root.trim(), ['diff', '--no-renames', from, to, '--', file]);
}

/** How long a turn's delivery waits, in all, for the previous turn's checkpoint and its own. */
export const NATIVE_CHECKPOINT_WAIT_MS = 3_000;

/** The value, or `undefined` once `ms` passed first. */
export async function withinMs<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<undefined>((resolve) => (timer = setTimeout(() => resolve(undefined), ms))),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
