import { spawn } from 'node:child_process';
import { copyFile, lstat, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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

/**
 * A session's checkpoints: commits of its Git working tree's content, untracked files Git does not
 * ignore included, built in a temporary index seeded from the worktree's own index (so Git's stat
 * cache hashes only files changed since), with `HEAD` as parent. The worktree, its index, `HEAD`
 * and every branch stay untouched. One Git call per step, never one per file.
 */
export class NativeCheckpoints {
  private last?: { commit: string; tree: string };
  /** The latest step; steps run one at a time, so ref transactions never race. */
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly root: string,
    private readonly gitDir: string,
    private readonly prefix: string,
    private refs: string[],
    private readonly kept: number,
  ) {}

  /** Checkpoints for a session whose working directory is in a Git working tree, or none. */
  static async open(
    cwd: string,
    sessionId: string,
    kept = NATIVE_CHECKPOINTS_KEPT,
  ): Promise<NativeCheckpoints | undefined> {
    const located = await git(cwd, ['rev-parse', '--show-toplevel', '--absolute-git-dir']).catch(
      () => undefined,
    );
    if (!located) return undefined;
    const [root, gitDir] = located.trim().split('\n');
    const prefix = `${REF_ROOT}/${sessionId}`;
    const refs = (await git(root, ['for-each-ref', '--format=%(refname)', `${prefix}/`]))
      .split('\n')
      .filter(Boolean)
      .sort();
    return new NativeCheckpoints(root, gitDir, prefix, refs, kept);
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
    const scratch = await mkdtemp(path.join(tmpdir(), 'farmslot-checkpoint-'));
    try {
      const index = path.join(scratch, 'index');
      await copyFile(path.join(this.gitDir, 'index'), index).catch((error: unknown) => {
        // A repository without an index yet: Git builds one from the working tree.
        if ((error as { code?: unknown }).code !== 'ENOENT') throw error;
      });
      const env = { GIT_INDEX_FILE: index };
      const untracked = await this.untracked(env);
      await git(this.root, ['add', '--update', '--', '.'], undefined, env);
      if (untracked.length) {
        const list = path.join(scratch, 'untracked');
        await writeFile(list, untracked.join('\0'));
        await git(
          this.root,
          ['add', `--pathspec-from-file=${list}`, '--pathspec-file-nul'],
          undefined,
          env,
        );
      }
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
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }

  /** Untracked files Git does not ignore, up to the size limit each. */
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

  /** Deletes the session's checkpoint refs; their diffs are no longer retained. */
  remove(): Promise<void> {
    return this.serial(async () => {
      if (this.refs.length) await this.updateRefs(this.refs.map((ref) => `delete ${ref}`));
      this.refs = [];
      this.last = undefined;
    });
  }

  private async updateRefs(lines: string[]): Promise<void> {
    const input = `start\n${lines.join('\n')}\nprepare\ncommit\n`;
    await gitWithInput(this.root, ['update-ref', '--stdin'], input);
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
      const [additions, deletions, file] = token.split('\t');
      const entry = files.get(file);
      if (entry && additions !== '-') {
        entry.additions = Number(additions);
        entry.deletions = Number(deletions);
      }
    }
  }
  return [...files.values()];
}

/** One file's diff between two checkpoints of the repository holding `cwd`; `file` is relative to its root. */
export async function nativeTurnDiff(
  cwd: string,
  from: string,
  to: string,
  file: string,
): Promise<string> {
  // Pathspecs are literal and relative to where Git runs, so run at the root.
  const root = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
  return git(root, ['diff', '--no-renames', from, to, '--', file]);
}

async function gitWithInput(cwd: string, args: string[], input: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      stdio: ['pipe', 'ignore', 'pipe'],
      env: Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
      ),
      timeout: 15_000,
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`git ${args[0]} failed: ${stderr.trim()}`)),
    );
    child.stdin.end(input);
  });
}

/** How long a turn's delivery waits for the checkpoint before it; a slower one is skipped. */
export const NATIVE_CHECKPOINT_WAIT_MS = 5_000;

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
