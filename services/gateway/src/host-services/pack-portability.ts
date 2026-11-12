// host-services/pack-portability.ts — the node-support pack check, with its `git` calls off the
// event loop. The CLI keeps the synchronous `validatePackPortability`; the walk and the policy are
// the same function in protocol.
import { execFile } from 'node:child_process';
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

/** A project pack checked against the portability policy, and the files that check read. */
export interface ProjectPackPortability {
  errors: string[];
  /** Absolute paths of the pack-owned files, so a caller can tell when the pack changed. */
  files: string[];
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
      files: entries.map((entry) => path.join(root, entry.rel)),
    };
  });
}
