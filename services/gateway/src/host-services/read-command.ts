// The existing background host pays local probe spawn cost away from the RPC process.
import { type ExecResult, NODE_EXEC_CLOSEOUT_MS } from '@farmslot/protocol';

import type { SlotVars } from '../core/config.js';
import { execOnSlot, type ExecOnSlotOptions, slotFilesReadInProcess } from '../core/exec.js';

import { backgroundHost } from './background/client.js';
import { BACKGROUND_OPERATIONS } from './background/protocol.js';

/** Only read callers opt in. Owned/source-bound and remote commands keep their existing executor. */
export function readSlotCommand(
  vars: SlotVars,
  command: string,
  options: ExecOnSlotOptions & { timeout: number },
): Promise<ExecResult> {
  if (!slotFilesReadInProcess(vars) || !backgroundHost.active())
    return execOnSlot(vars, command, options);
  const { timeout, signal, maxBuffer, closeoutTimeoutMs } = options;
  return backgroundHost.request(
    BACKGROUND_OPERATIONS.readCommand,
    {
      command,
      cwd: options.cwd ?? vars.remoteRepo,
      timeout,
      ...(maxBuffer === undefined ? {} : { maxBuffer }),
      ...(closeoutTimeoutMs === undefined ? {} : { closeoutTimeoutMs }),
    },
    // IPC must allow the command's normal budget and bounded termination to settle.
    { deadlineMs: timeout + (closeoutTimeoutMs ?? NODE_EXEC_CLOSEOUT_MS), signal },
  );
}
