// What the gateway-background process runs for each operation: the same functions the gateway
// would call in-process, so a probe's result does not depend on where it ran.
import { checkLocalMachineSlots } from '../../methods/fleet.js';
import { loadFileDecisions } from '../../observability/fleet-monitor.js';

import type { BackgroundOperation, BackgroundParams, BackgroundResult } from './protocol.js';

export type BackgroundHandlers = {
  [O in BackgroundOperation]: (params: BackgroundParams<O>) => Promise<BackgroundResult<O>>;
};

export const backgroundHandlers: BackgroundHandlers = {
  'fleet.probeMachine': ({ entries, ssh }) => checkLocalMachineSlots(entries, new Map(ssh)),
  'decisions.scan': () => loadFileDecisions(),
};

/**
 * Operations that run commands. The child attributes its exec counters to the completing request
 * of one of these; `decisions.scan` only reads files, so concurrent scans never take a probe's
 * commands. A second command-running operation needs per-request attribution first.
 */
export const COMMAND_OPERATIONS: ReadonlySet<BackgroundOperation> = new Set(['fleet.probeMachine']);
