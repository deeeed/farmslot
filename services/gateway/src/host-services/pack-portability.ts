// host-services/pack-portability.ts — the node-support pack check, with its `git` calls off the
// event loop. The CLI keeps the synchronous `validatePackPortability`; the walk and the policy are
// the same function in protocol.
import { execFile } from 'node:child_process';

import {
  type PackGitResult,
  validatePackPortabilityAsync,
} from '@farmslot/protocol/node/pack-portability';

import {
  executionKind,
  measureManagedOperation,
  registerHostOperations,
  withHostOperation,
} from '../observability/performance.js';

export const PACK_PORTABILITY_OPS = { validate: 'packPortability.validate' } as const;
registerHostOperations(Object.values(PACK_PORTABILITY_OPS));

/**
 * `git` as `spawnSync` reports it: the exit status (null when it did not run or overran the
 * buffer, which spawnSync also caps at 1 MiB) and stdout as bytes, decoded once by the walk.
 */
function runGit(args: string[]): Promise<PackGitResult> {
  return measureManagedOperation(
    'exec',
    executionKind('git', args),
    () =>
      new Promise((resolve) => {
        execFile('git', args, { encoding: 'buffer' }, (error, stdout) => {
          // A non-zero exit is an answer the walk branches on (128: not inside a repository).
          // Anything else reports no status, which the walk refuses.
          const status = !error ? 0 : typeof error.code === 'number' ? error.code : null;
          resolve({ status, stdout });
        });
      }),
  );
}

/** Every pack-owned file of a project checked against the portability policy. */
export function validateProjectPackPortability(
  root: string,
  prefix: string,
  machines: readonly string[],
): Promise<string[]> {
  return withHostOperation(PACK_PORTABILITY_OPS.validate, () =>
    validatePackPortabilityAsync(root, prefix, machines, runGit),
  );
}
