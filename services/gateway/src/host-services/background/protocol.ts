// The gateway-background process contract: which operations it serves and the IPC messages that
// carry them. Types only, plus the operation names, so either process can import it cheaply.
import type { ExecResult } from '@farmslot/protocol';

import type { ExecTally } from '../../observability/performance.js';
export type { ExecTally } from '../../observability/performance.js';

import type { HostCheck, PoolSlotEntry, SlotCheckResult } from '../../methods/fleet.js';
import type { FileDecision } from '../../observability/fleet-monitor.js';

/** Stable operation names; metrics and the status snapshot attribute work to these. */
export const BACKGROUND_OPERATIONS = {
  fleetProbeMachine: 'fleet.probeMachine',
  decisionsScan: 'decisions.scan',
  readCommand: 'commands.read',
} as const;

export interface BackgroundOperationContract {
  /** Every slot check of one local machine, as the fleet refresh would run it in-process. */
  'fleet.probeMachine': {
    params: { entries: PoolSlotEntry[]; ssh: Array<[string, HostCheck]> };
    result: SlotCheckResult[];
  };
  /** The pending-decision walk over every project task root. */
  'decisions.scan': { params: Record<string, never>; result: FileDecision[] };
  /** Read-only commands from the shared probe/workspace readers, never owned mutations. */
  'commands.read': {
    params: {
      command: string;
      cwd: string;
      timeout: number;
      maxBuffer?: number;
      closeoutTimeoutMs?: number;
    };
    result: ExecResult;
  };
}

export type BackgroundOperation = keyof BackgroundOperationContract;
export type BackgroundParams<O extends BackgroundOperation> =
  BackgroundOperationContract[O]['params'];
export type BackgroundResult<O extends BackgroundOperation> =
  BackgroundOperationContract[O]['result'];

export type BackgroundRequestMessage = {
  [O in BackgroundOperation]: {
    type: 'request';
    id: number;
    operation: O;
    params: BackgroundParams<O>;
  };
}[BackgroundOperation];
export interface BackgroundShutdownMessage {
  type: 'shutdown';
}
export interface BackgroundCancelMessage {
  type: 'cancel';
  id: number;
}
export type BackgroundParentMessage =
  | BackgroundRequestMessage
  | BackgroundShutdownMessage
  | BackgroundCancelMessage;

export interface BackgroundReadyMessage {
  type: 'ready';
  pid: number;
  rssBytes: number;
  /** Handles alive once the handlers are imported: the IPC channel and stdio, nothing else. */
  activeResources: string[];
}
interface BackgroundResultBase {
  type: 'result';
  id: number;
  operation: BackgroundOperation;
  exec: ExecTally;
  rssBytes: number;
}
export interface BackgroundSuccessMessage extends BackgroundResultBase {
  ok: true;
  value: unknown;
}
export interface BackgroundFailureMessage extends BackgroundResultBase {
  ok: false;
  error: { name: string; message: string };
}
export type BackgroundChildMessage =
  | BackgroundReadyMessage
  | BackgroundSuccessMessage
  | BackgroundFailureMessage;
