// What the gateway-background process runs for each operation: the same functions the gateway
// would call in-process, so a probe's result does not depend on where it ran.
import { execLocal } from '../../core/exec.js';
import { checkMachineSlots } from '../../methods/fleet.js';
import { loadFileDecisions } from '../../observability/fleet-monitor.js';

import type { BackgroundOperation, BackgroundParams, BackgroundResult } from './protocol.js';

export type BackgroundHandlers = {
  [O in BackgroundOperation]: (
    params: BackgroundParams<O>,
    context?: { signal: AbortSignal },
  ) => Promise<BackgroundResult<O>>;
};

export const backgroundHandlers: BackgroundHandlers = {
  'fleet.probeMachine': ({ entries, ssh }) => checkMachineSlots(entries, new Map(ssh)),
  'decisions.scan': () => loadFileDecisions(),
  'commands.read': ({ command, ...options }, context) =>
    execLocal(command, { ...options, signal: context?.signal }),
};

/** Only command-running requests carry an execution tally. */
export const COMMAND_OPERATIONS: ReadonlySet<BackgroundOperation> = new Set([
  'fleet.probeMachine',
  'commands.read',
]);
