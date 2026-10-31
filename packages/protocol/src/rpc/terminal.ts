import type { AgentRole } from '../contracts/index.js';

import type { TmuxWorkerRef } from './tmux.js';

export interface SlotAgentTargetParams {
  /** Empty with runId selects that run’s allocated review-worktree shell. */
  slotId: string;
  runId?: string;
  role?: AgentRole;
  contextId?: string;
  target?: string;
  // Skip active-run / agent-context resolution and route to the bare tmux session.
  // Lives on the base type so subscribe + input + resize + reinit + snapshot + send +
  // tmux all share one routing flag — postmortem callers must keep input/resize aligned
  // with whichever target subscribe attached to, otherwise keystrokes miss the bare PTY.
  bareSession?: boolean;
}

export interface TerminalSubscribeParams extends SlotAgentTargetParams {
  interactive?: boolean;
  cols?: number;
  rows?: number;
}

export interface TerminalSendParams extends SlotAgentTargetParams {
  /** Retry-stable identity for an authenticated PR-completion instruction. */
  operatorMessageId?: string;
  text: string;
  enter?: boolean;
}

export interface TerminalSnapshotParams extends SlotAgentTargetParams {
  lines?: number;
}

/**
 * Numbers one input batch within a client's stream for a pane. A gateway that advertises
 * `terminalInputSequence` writes each number once, so a batch resent after a lost reply is
 * acknowledged without being typed again.
 */
export interface TerminalInputSequence {
  /** Random per client input queue; a new queue starts a new stream. */
  stream: string;
  /** Increases by one per batch in the stream. */
  n: number;
}

export interface TerminalInputParams extends SlotAgentTargetParams {
  data: string; // raw keystroke data from xterm.js onData
  seq?: TerminalInputSequence;
}

export interface TerminalResizeParams extends SlotAgentTargetParams {
  cols: number;
  rows: number;
}

export interface TerminalReinitParams extends SlotAgentTargetParams {}
export interface TerminalSnapshotResult {
  slotId: string;
  role?: AgentRole;
  contextId?: string;
  lines: string[];
  timestamp: number;
}

export interface TerminalWorkerSubscribeParams {
  worker: TmuxWorkerRef;
  lines?: number;
  cols?: number;
  rows?: number;
}

export interface TerminalWorkerUnsubscribeParams {
  worker: TmuxWorkerRef;
}

export interface TerminalWorkerInputParams {
  worker: TmuxWorkerRef;
  data: string;
  seq?: TerminalInputSequence;
}

export interface TerminalWorkerResizeParams {
  worker: TmuxWorkerRef;
  cols: number;
  rows: number;
}

export interface TerminalWorkerSnapshotParams {
  worker: TmuxWorkerRef;
  lines?: number;
}

export interface TerminalWorkerSnapshotResult {
  worker: TmuxWorkerRef;
  lines: string[];
  timestamp: number;
}
