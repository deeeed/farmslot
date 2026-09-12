/** Native sessions are opt-in. Authentication and agent execution remain runner-owned. */
export interface NativeSessionCapabilities {
  modes: Array<'default' | 'plan'>;
  streaming: boolean;
  tools: boolean;
  approvals: boolean;
  questions: boolean;
  interrupt: boolean;
  resume: boolean;
}

export interface NativeSessionCreateParams {
  runner: string;
  cwd: string;
  model?: string;
  mode?: 'default' | 'plan';
  /** Exact native identity, never a live TUI takeover. */
  resumeSessionId?: string;
}
export interface NativeSessionTargetParams {
  sessionId: string;
}
export interface NativeSessionReadParams extends NativeSessionTargetParams {
  after?: number;
}
export interface NativeSessionSendParams extends NativeSessionTargetParams {
  commandId: string;
  text: string;
}
export interface NativeSessionSendResult {
  commandId: string;
  /** Input reached the owned transport; this alone does not prove native acceptance. */
  submitted: true;
  /** True only after native protocol evidence confirms acceptance. */
  accepted: boolean;
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
  at: string;
  type:
    | 'session.started'
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
  request?: {
    id: string;
    title: string;
    detail?: string;
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
}
