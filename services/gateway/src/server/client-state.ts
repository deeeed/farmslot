// client-state.ts — WebSocket client and terminal subscription state types

import type { WebSocket } from 'ws';

import type {
  GatewayAuthClientKind,
  GatewayAuthMode,
  TerminalData,
  TerminalSubscribeParams,
} from '@farmslot/protocol';

import type { WorkerTerminalPtyHandler } from '../methods/terminal-worker.js';
import type { WorkerSessionHistoryUnsubscribe } from '../methods/worker-session-history.js';
import type { PtyDataHandler } from '../runtime/pty-stream.js';
import type { ScreenFrameHandler } from '../runtime/screen-session.js';

export interface TerminalSubscriptionState {
  terminalHandlers: Map<string, (data: TerminalData) => void>;
  workerTerminalHandlers: Map<string, WorkerTerminalPtyHandler>;
  ptyHandlers: Map<string, PtyDataHandler>;
  terminalIdentities: Map<
    string,
    { slotId: string; runId?: string; role?: TerminalSubscribeParams['role']; contextId?: string }
  >;
  workerSessionHistoryHandlers: Map<string, WorkerSessionHistoryUnsubscribe>;
  // Per-slot subscribe sequence: a fresh subscribe call increments this before
  // awaiting any I/O. After the await, the late completer compares its captured
  // sequence to the current value; mismatch = a newer subscribe ran in the gap,
  // so the late completer must undo its registration to avoid clobbering it.
  // Intentionally NOT pruned on unsubscribe — the next subscribe just bumps
  // from the existing value. Deleting on unsubscribe would let a re-subscribe
  // restart from 1 and accept a stale completer's mySeq=1 by mistake.
  terminalSubscribeSeq: Map<string, number>;
}

export interface ClientState extends TerminalSubscriptionState {
  id: string;
  ws: WebSocket;
  screenHandlers: Map<string, ScreenFrameHandler>;
  thumbnailSubscribed: boolean;
  authenticated: boolean;
  clientKind?: GatewayAuthClientKind;
  authMode?: GatewayAuthMode;
  authenticatedAt?: number;
}
