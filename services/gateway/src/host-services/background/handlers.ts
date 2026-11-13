// What the gateway-background process runs for each operation: the same functions the gateway
// would call in-process, so a probe's result does not depend on where it ran.
import { execLocal } from '../../core/exec.js';
import { checkMachineSlots } from '../../methods/fleet.js';
import { loadFileDecisions } from '../../observability/fleet-monitor.js';

import type {
  BackgroundCommandParams,
  BackgroundOperation,
  BackgroundParams,
  BackgroundResult,
} from './protocol.js';

export interface BackgroundHandlerContext {
  signal: AbortSignal;
}

export type BackgroundHandlers = {
  [O in BackgroundOperation]: (
    params: BackgroundParams<O>,
    context?: BackgroundHandlerContext,
  ) => Promise<BackgroundResult<O>>;
};

function command(
  { command, ...options }: BackgroundCommandParams,
  context?: BackgroundHandlerContext,
) {
  return execLocal(command, { ...options, signal: context?.signal });
}

export const backgroundHandlers: BackgroundHandlers = {
  'fleet.probeMachine': ({ entries, ssh }) => checkMachineSlots(entries, new Map(ssh)),
  'decisions.scan': () => loadFileDecisions(),
  'commands.read': command,
  'taskFiles.transfer': command,
};

/** Only command-running requests carry an execution tally. */
export const COMMAND_OPERATIONS: ReadonlySet<BackgroundOperation> = new Set([
  'fleet.probeMachine',
  'commands.read',
  'taskFiles.transfer',
]);
