// host-services/pack-portability.ts — the node-support pack check, with its `git` calls off the
// event loop. The CLI keeps the synchronous `validatePackPortability`; the walk and the policy are
// the same function in protocol.
import { execFile } from 'node:child_process';
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';

import {
  listPackOwnedEntriesAsync,
  type PackGitResult,
  validatePackEntries,
} from '@farmslot/protocol/node/pack-portability';

import {
  executionKind,
  measureManagedOperation,
  registerHostOperations,
  withHostOperation,
} from '../observability/performance.js';

export const PACK_PORTABILITY_OPS = { validate: 'packPortability.validate' } as const;
registerHostOperations(Object.values(PACK_PORTABILITY_OPS));

/** spawnSync's default buffer, which counts stdout and stderr together. */
const GIT_OUTPUT_MAX_BYTES = 1024 * 1024;

/**
 * `git` as `spawnSync` reports it: the exit status (null when it did not run or its stdout and
 * stderr together overran 1 MiB) and stdout as bytes, decoded once by the walk.
 * Not `core/exec`: that decodes output per chunk and rewrites PATH; the walk needs bytes and `git`.
 */
function runGit(args: string[]): Promise<PackGitResult> {
  return measureManagedOperation(
    'exec',
    executionKind('git', args),
    () =>
      new Promise((resolve) => {
        let output = 0;
        let overran = false;
        const child = execFile('git', args, { encoding: 'buffer' }, (error, stdout) => {
          // A non-zero exit is an answer the walk branches on (128: not inside a repository).
          // Anything else reports no status, which the walk refuses.
          const status = !error ? 0 : typeof error.code === 'number' ? error.code : null;
          resolve({ status: overran ? null : status, stdout });
        });
        // execFile caps each stream separately; spawnSync caps them together.
        const count = (chunk: Buffer) => {
          output += chunk.length;
          if (output <= GIT_OUTPUT_MAX_BYTES || overran) return;
          overran = true;
          child.kill();
        };
        child.stdout?.on('data', count);
        child.stderr?.on('data', count);
      }),
  );
}

/** What a pack check read or depends on, so a caller can tell when its answer may change. */
export interface PackCheckInputs {
  /** Pack-owned files, a link as the link itself. */
  files: string[];
  /**
   * Directories where a new file would be owned: in a pack that is its own repository, every
   * directory but ignored ones, `.git` and `node_modules`; otherwise the root and the directories
   * holding owned files.
   */
  directories: string[];
  /** Ownership rules, which may be absent: the Git index, `info/exclude` and `.gitignore` files. */
  rules: string[];
}

/** A project pack checked against the portability policy, and what that check depends on. */
export interface ProjectPackPortability {
  errors: string[];
  inputs: PackCheckInputs;
}

function gitLines(result: PackGitResult, what: string): string[] {
  if (result.status !== 0) throw new Error(`Cannot read ${what} for the pack check`);
  return result.stdout.toString().split('\0').filter(Boolean);
}

/** Directories under `root` (itself included) outside `skipped`, and the `.gitignore` files in them. */
async function walkPackDirectories(
  root: string,
  skipped: ReadonlySet<string>,
): Promise<{ directories: string[]; ignoreFiles: string[] }> {
  const directories: string[] = [];
  const ignoreFiles: string[] = [];
  const visit = async (dir: string, rel: string): Promise<void> => {
    directories.push(dir);
    const children: Promise<void>[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.name === '.gitignore') ignoreFiles.push(path.join(dir, entry.name));
      if (!entry.isDirectory() || entry.name === '.git' || entry.name === 'node_modules') continue;
      if (!skipped.has(childRel)) children.push(visit(path.join(dir, entry.name), childRel));
    }
    await Promise.all(children);
  };
  await visit(root, '');
  return { directories, ignoreFiles };
}

async function packCheckInputs(root: string, files: string[]): Promise<PackCheckInputs> {
  let ownRepository = true;
  try {
    await lstat(path.join(root, '.git'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    ownRepository = false;
  }
  if (!ownRepository) {
    // A copied pack: its ownership follows its files, so the directories holding them suffice.
    const directories = new Set([root]);
    for (const file of files)
      for (let dir = path.dirname(file); dir.startsWith(`${root}/`); dir = path.dirname(dir))
        directories.add(dir);
    return { files, directories: [...directories], rules: [] };
  }
  const [gitPaths, ignored] = await Promise.all([
    runGit(['-C', root, 'rev-parse', '--git-path', 'index', '--git-path', 'info/exclude']),
    // Directories an ignore rule matches, not ones that only hold ignored files; no index write.
    runGit([
      '-C',
      root,
      '--no-optional-locks',
      'status',
      '--porcelain=v1',
      '-z',
      '--ignored=matching',
      '--untracked-files=all',
    ]),
  ]);
  const rules = gitPaths.stdout
    .toString()
    .split('\n')
    .filter(Boolean)
    .map((line) => path.resolve(root, line));
  if (gitPaths.status !== 0 || rules.length !== 2)
    throw new Error('Cannot locate the pack repository for the pack check');
  const skipped = new Set(
    gitLines(ignored, 'ignored pack directories')
      .filter((entry) => entry.startsWith('!! ') && entry.endsWith('/'))
      .map((entry) => entry.slice(3, -1)),
  );
  const walked = await walkPackDirectories(root, skipped);
  return { files, directories: walked.directories, rules: [...rules, ...walked.ignoreFiles] };
}

/** Every pack-owned file of a project checked against the portability policy. */
export function validateProjectPackPortability(
  root: string,
  prefix: string,
  machines: readonly string[],
): Promise<ProjectPackPortability> {
  return withHostOperation(PACK_PORTABILITY_OPS.validate, async () => {
    const entries = await listPackOwnedEntriesAsync(root, runGit);
    return {
      errors: validatePackEntries(entries, prefix, machines),
      inputs: await packCheckInputs(
        root,
        entries.map((entry) => path.join(root, entry.rel)),
      ),
    };
  });
}
