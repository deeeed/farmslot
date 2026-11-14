// The existing background host pays local probe spawn cost away from the RPC process.
import type { ExecResult } from '@farmslot/protocol';

import type { SlotVars } from '../core/config.js';
import {
  execLocal,
  execOnSlot,
  type ExecOnSlotOptions,
  type ExecOptions,
  slotFilesReadInProcess,
} from '../core/exec.js';

import { backgroundHost } from './background/client.js';
import { BACKGROUND_OPERATIONS } from './background/protocol.js';
import { runBackgroundCommand } from './background-command.js';

export interface LocalReadCommandOptions extends Pick<
  ExecOptions,
  'maxBuffer' | 'signal' | 'closeoutTimeoutMs'
> {
  cwd: string;
  timeout: number;
}

/** Local read probes use the same host and in-process validation path as slot reads. */
export function readLocalCommand(
  command: string,
  options: LocalReadCommandOptions,
): Promise<ExecResult> {
  if (!backgroundHost.active()) return execLocal(command, options);
  const { signal, ...params } = options;
  return runBackgroundCommand(BACKGROUND_OPERATIONS.readCommand, { command, ...params }, signal);
}

/** Only read callers opt in. Owned/source-bound and remote commands keep their existing executor. */
export function readSlotCommand(
  vars: SlotVars,
  command: string,
  options: ExecOnSlotOptions & { timeout: number },
): Promise<ExecResult> {
  if (!slotFilesReadInProcess(vars) || !backgroundHost.active())
    return execOnSlot(vars, command, options);
  const { timeout, signal, maxBuffer, closeoutTimeoutMs } = options;
  return runBackgroundCommand(
    BACKGROUND_OPERATIONS.readCommand,
    {
      command,
      cwd: options.cwd ?? vars.remoteRepo,
      timeout,
      ...(maxBuffer === undefined ? {} : { maxBuffer }),
      ...(closeoutTimeoutMs === undefined ? {} : { closeoutTimeoutMs }),
    },
    signal,
  );
}
