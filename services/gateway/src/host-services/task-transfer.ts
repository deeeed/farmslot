import { cleanupSignal } from '../core/cleanup-scope.js';
import { execLocal, type ExecOptions, type ExecResult } from '../core/exec.js';

import { backgroundHost } from './background/client.js';
import { BACKGROUND_OPERATIONS } from './background/protocol.js';
import { runBackgroundCommand } from './background-command.js';

type TaskTransferOptions = Pick<
  ExecOptions,
  'cwd' | 'timeout' | 'signal' | 'maxBuffer' | 'closeoutTimeoutMs'
>;

/** Move the existing task-staging commands, without changing their shell or copy semantics. */
export function runTaskTransfer(
  command: string,
  options: TaskTransferOptions = {},
): Promise<ExecResult> {
  const signal = cleanupSignal(options.signal);
  // Core exec already handles a pre-aborted command without starting a process.
  if (!backgroundHost.active() || signal?.aborted) return execLocal(command, options);
  const { signal: _signal, ...execution } = options;
  return runBackgroundCommand(
    BACKGROUND_OPERATIONS.taskTransfer,
    { command, ...execution, cwd: options.cwd ?? process.cwd() },
    options.signal,
  );
}
