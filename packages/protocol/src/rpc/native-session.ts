/** Native sessions are opt-in. Authentication and agent execution remain runner-owned. */
export interface NativeSessionCapabilities {
  modes: Array<'default' | 'plan'>;
  streaming: boolean;
  tools: boolean;
  approvals: boolean;
  questions: boolean;
  interrupt: boolean;
  resume: boolean;
  resumeUnavailableReason?: string;
}

export interface NativeSessionCreateParams {
  /** Omitted or local selects the gateway host; otherwise an authenticated execution node. */
  executionNodeId?: string;
  runner: string;
  cwd: string;
  model?: string;
  mode?: 'default' | 'plan';
  /** Exact native identity, never a live TUI takeover. */
  resumeSessionId?: string;
}
export interface NativeSessionTargetParams {
  sessionId: string;
  executionNodeId?: string;
}

/** Idempotent initial creation. Older runtimes reject this operation without launching. */
export interface NativeSessionEnsureParams extends Omit<
  NativeSessionCreateParams,
  'resumeSessionId'
> {
  /** Lowercase UUID prevents journal aliases on case-insensitive filesystems. */
  sessionId: string;
}

/** Opt-in declaration made by an authenticated node, not a client-supplied account claim. */
export interface NativeExecutionNodeDeclaration {
  ownerPrincipalId: string;
  /** The node routes reserved creation; its retained host is checked separately at invocation. */
  supportsEnsure?: boolean;
}
export interface NativeSessionListResult {
  sessions: NativeSessionInfo[];
  unavailableExecutionNodes?: Array<{ executionNodeId: string; message: string }>;
}
export interface NativeSessionReadParams extends NativeSessionTargetParams {
  after?: number;
  /** 1..500 events per page, default 200. */
  limit?: number;
}
export interface NativeSessionSendParams extends NativeSessionTargetParams {
  commandId: string;
  text: string;
}
export interface NativeSessionSendResult {
  commandId: string;
  /** Submission was attempted or may have occurred; this is not native acceptance. */
  submitted: boolean;
  state: NativeCommandState;
  /** True only after native protocol evidence confirms acceptance. */
  accepted: boolean;
}
export type NativeCommandState = 'pending' | 'unknown' | 'accepted' | 'failed' | 'completed';
export interface NativeCommandReceipt {
  generation: string;
  commandId: string;
  state: NativeCommandState;
  submitted: boolean;
  accepted: boolean;
  outcome?: 'completed' | 'failed' | 'interrupted';
}

export interface NativeSessionResponse {
  decision?: 'approve' | 'deny';
  answers?: Record<string, string[]>;
}
export interface NativeSessionRespondParams
  extends NativeSessionTargetParams, NativeSessionResponse {
  requestId: string;
}
export interface NativeSessionInfo {
  id: string;
  /** Host generation, distinct from the native conversation identity. */
  generation: string;
  hostPid: number;
  /** Process group leader. Retained as historical evidence after cleanup. */
  processPid?: number;
  /** Non-secret argv marker for verifying process ownership before delayed cleanup. */
  processIdentity?: string;
  /** Wrapper group and observed descendants stopped; not exhaustive OS containment. */
  processStopped?: boolean;
  recovery?: string;
  runner: string;
  nativeSessionId: string;
  ownerPrincipalId: string;
  executionNodeId: string;
  accountContextId: string;
  cwd: string;
  executable: string;
  version: string;
  model?: string;
  mode: 'default' | 'plan';
  accountMode: 'native';
  capabilities: NativeSessionCapabilities;
  state: 'starting' | 'idle' | 'waiting' | 'running' | 'closing' | 'closed' | 'failed';
}
export interface NativeSessionEvent {
  sessionId: string;
  sequence: number;
  generation: string;
  at: string;
  type:
    | 'session.started'
    | 'command.submitted'
    | 'command.accepted'
    | 'turn.started'
    | 'text.delta'
    | 'tool.started'
    | 'tool.completed'
    | 'approval.requested'
    | 'approval.resolved'
    | 'question.requested'
    | 'turn.completed'
    | 'session.closed'
    | 'error';
  commandId?: string;
  turnId?: string;
  nativeId?: string;
  text?: string;
  tool?: { name: string; input?: unknown; output?: unknown; status?: string };
  responseState?: 'unknown';
  request?: {
    id: string;
    title: string;
    detail?: string;
    /** Proposed action captured from the native tool event for this request. */
    tool?: NativeSessionEvent['tool'];
    questions?: Array<{
      id: string;
      prompt: string;
      options: Array<{ label: string; description?: string }>;
      multiSelect?: boolean;
    }>;
  };
  status?: 'completed' | 'failed' | 'interrupted';
  /** Runner-specific diagnostics; clients render normalized fields above. */
  data?: Record<string, unknown>;
}
export interface NativeSessionReadResult {
  session: NativeSessionInfo;
  events: NativeSessionEvent[];
  cursor: number;
  hasMore: boolean;
  /** Most recent 100 receipts. Older command IDs remain durably deduplicated. */
  commands: NativeCommandReceipt[];
  pendingRequests: NativeSessionEvent[];
}

/** Curated native choices; availability and billing remain account-owned. */
export interface NativeRunnerOption {
  runner: string;
  models: string[];
  defaultModel: string;
  modes: Array<'default' | 'plan'>;
}
export interface NativeSessionCatalogResult {
  runners: NativeRunnerOption[];
  contexts: Array<{
    cwd: string;
    label: string;
    slotId?: string;
    project?: string;
    executionNodeId?: string;
  }>;
}
export interface NativeWorkspacePathParams extends NativeSessionTargetParams {
  /** Relative to the session's recorded working directory. */
  path: string;
}
export interface NativeWorkspaceListResult {
  entries: Array<{ path: string; name: string; directory: boolean }>;
  truncated: boolean;
}
export interface NativeWorkspaceChangesResult {
  files: Array<{ path: string; status: string }>;
  truncated?: boolean;
}
export interface NativeWorkspaceReadResult {
  path: string;
  content: string;
}
export interface NativeWorkspaceDiffResult {
  path: string;
  diff: string;
}
