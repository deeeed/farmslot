import { type ExecResult, NODE_EXEC_CLOSEOUT_MS } from '@farmslot/protocol';

import { cleanupSignal, trackCleanupCommand } from '../core/cleanup-scope.js';

import { backgroundHost } from './background/client.js';
import type { BackgroundParams } from './background/protocol.js';

/** Both command owners retain cancellation until the child confirms process closeout. */
export function runBackgroundCommand<O extends 'commands.read' | 'taskFiles.transfer'>(
  operation: O,
  params: BackgroundParams<O>,
  signal?: AbortSignal,
): Promise<ExecResult> {
  return trackCleanupCommand(
    backgroundHost.request(operation, params, {
      deadlineMs:
        params.timeout === undefined
          ? null
          : params.timeout + (params.closeoutTimeoutMs ?? NODE_EXEC_CLOSEOUT_MS),
      signal: cleanupSignal(signal),
    }),
  );
}
