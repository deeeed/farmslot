// methods/tmux.ts — node-scoped tmux worker inventory

export type TmuxWorkerStatusSource =
  | 'hook'
  | 'statusline'
  | 'task-file'
  | 'tmux'
  | 'gateway'
  | 'inferred'
  | 'unknown';

export type TmuxWorkerStatusConfidence = 'high' | 'medium' | 'low';

export type TmuxWorkerActivityState = 'active' | 'waiting' | 'idle' | 'stale' | 'unknown';
export type TmuxWorkerAttentionReason = 'waiting' | 'idle' | 'stale-signal';

export interface TmuxWorkerRef {
  nodeId: string;
  session: string;
  window?: string;
  windowName?: string;
  pane?: string;
  paneId?: string;
  target: string;
}

export interface TmuxWorkerStatusReading {
  label: string;
  source: TmuxWorkerStatusSource;
  confidence: TmuxWorkerStatusConfidence;
  observedAt?: number;
  stale?: boolean;
  state?: TmuxWorkerActivityState;
  requiresAttention?: boolean;
  attentionReason?: TmuxWorkerAttentionReason;
  conflicts?: string[];
}

export interface TmuxWorkerSummary {
  ref: TmuxWorkerRef;
  title?: string;
  cwd?: string;
  command?: string;
  pid?: number;
  width?: number;
  height?: number;
  active?: boolean;
  linkedSlotId?: string;
  linkedRunId?: string;
  linkedFamilyId?: string;
  branch?: string;
  lastChangedAt?: number;
  status: TmuxWorkerStatusReading;
}

export interface TmuxWorkerNodeSummary {
  panes: number;
  active: number;
  waiting: number;
  idle: number;
  stale: number;
  unknown: number;
}

export interface TmuxWorkerNodeResult {
  nodeId: string;
  connected: boolean;
  ok: boolean;
  observedAt: number;
  workers: TmuxWorkerSummary[];
  summary?: TmuxWorkerNodeSummary;
  hiddenWorkers?: number;
  error?: string;
}

export interface TmuxWorkerListParams {
  /** Include registered pool machines that currently have no connected node. Default true. */
  includeDisconnected?: boolean;
}

export interface TmuxWorkerListResult {
  observedAt: number;
  nodes: TmuxWorkerNodeResult[];
  workers: TmuxWorkerSummary[];
  hiddenWorkers?: number;
}

// Gateway↔node private tmux pane inventory payload. Public because the gateway
// and node packages share protocol types, but not exposed as a JSON-RPC method.
export interface NodeTmuxPaneSignals {
  hook?: {
    label?: string;
    observedAt?: number;
    event?: string;
  };
  statusline?: {
    label?: string;
    observedAt?: number;
    busy?: boolean;
    model?: string;
    ctxPct?: number;
  };
  taskFile?: {
    label?: string;
    observedAt?: number;
    status?: string;
    phase?: string;
  };
}

export interface NodeTmuxPane {
  session: string;
  window: string;
  windowName?: string;
  pane: string;
  paneId?: string;
  target: string;
  active?: boolean;
  width?: number;
  height?: number;
  title?: string;
  cwd?: string;
  command?: string;
  pid?: number;
  branch?: string;
  observedAt?: number;
  lastChangedAt?: number;
  signals?: NodeTmuxPaneSignals;
}

export interface NodeTmuxPanesResult {
  panes: NodeTmuxPane[];
}
