import type { AgentRole } from '../contracts/index.js';

import type { TmuxWorkerRef } from './tmux.js';

export interface SlotAgentTargetParams {
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
  text: string;
  enter?: boolean;
}

export interface TerminalSnapshotParams extends SlotAgentTargetParams {
  lines?: number;
}

export interface TerminalInputParams extends SlotAgentTargetParams {
  data: string; // raw keystroke data from xterm.js onData
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
