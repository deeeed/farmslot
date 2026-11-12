// host-services/execution-template-git.ts — the `git` calls that date and check execution-template
// sources, off the event loop. The CLI keeps the synchronous resolvers in agent-runtime; the path
// checks and the answers are the same functions there.
import { spawn } from 'node:child_process';

import type { ExecutionTemplateGitResult } from '@farmslot/agent-runtime';

import { executionKind, measureManagedOperation } from '../observability/performance.js';

/** spawnSync's default buffer for stdout, the only stream these calls read. */
const GIT_STDOUT_MAX_BYTES = 1024 * 1024;

/**
 * `git` as the synchronous resolvers' `spawnSync` reports it: the exit status (null when it did
 * not run or its stdout overran 1 MiB) and stdout. stderr is ignored, as there.
 * Not `core/exec`: it puts shims first on PATH and counts stderr against its buffer.
 */
export function runExecutionTemplateGit(args: string[]): Promise<ExecutionTemplateGitResult> {
  return measureManagedOperation(
    'exec',
    executionKind('git', args),
    () =>
      new Promise((resolve) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let overran = false;
        const child = spawn('git', args, { stdio: ['ignore', 'pipe', 'ignore'] });
        child.stdout.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size <= GIT_STDOUT_MAX_BYTES) chunks.push(chunk);
          else if (!overran) {
            overran = true;
            child.kill();
          }
        });
        // A git that cannot start reports no status, as spawnSync does; the callers read that as
        // "unknown" and leave the field out.
        child.on('error', () => resolve({ status: null, stdout: '' }));
        child.on('close', (code) =>
          resolve({
            status: overran ? null : code,
            stdout: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      }),
  );
}
