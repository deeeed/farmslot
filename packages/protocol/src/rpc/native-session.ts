import type {
  NativeResultSchema,
  NativeStructuredResult,
} from '../recipe/pipeline-visual-judgments.js';

/** Native sessions are opt-in. Authentication and agent execution remain runner-owned. */
export interface NativeSessionCapabilities {
  modes: Array<'default' | 'plan'>;
  streaming: boolean;
  tools: boolean;
  approvals: boolean;
  questions: boolean;
  interrupt: boolean;
  resume: boolean;
  /** Saved conversation may resume in a sibling worktree on the same execution host. */
  resumeAcrossWorkspaces?: boolean;
  resumeUnavailableReason?: string;
  /** Schemas accepted and validated through provider-native constrained results. */
  structuredResultSchemas?: NativeResultSchema[];
  /** Set by the host: `native.session.cancel` removes a queued message. Absent on older hosts. */
  cancelQueued?: boolean;
}

export interface NativeSessionCreateParams {
  /** Omitted or local selects the gateway host; otherwise an authenticated execution node. */
  executionNodeId?: string;
  /** Named native account profile on this execution node; omitted preserves ambient behavior. */
  profileId?: string;
  /** Required with profileId; guards a selection made before a profile was replaced. */
  accountContextId?: string;
  runner: string;
  cwd: string;
  model?: string;
  effort?: string;
  mode?: 'default' | 'plan';
  /** Pipeline reviewers bind this schema before their first command. */
  resultSchema?: NativeResultSchema;
  /** Exact native identity, never a live TUI takeover. */
  resumeSessionId?: string;
}
export interface NativeSessionTargetParams {
  sessionId: string;
  executionNodeId?: string;
  /** Pin a worker view to its run, rather than adopting a successor's refreshed lease. */
  worker?: NativeWorkerControlTarget;
}

export interface NativeWorkerControlTarget {
  runId: string;
  contextId: string;
  generation: string;
  leaseId: string;
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
  /** Source-backed journal/account receipts on the authenticated node connection. */
  supportsObservations?: boolean;
  ownerPrincipalId: string;
  /** The node routes reserved creation; its retained host is checked separately at invocation. */
  supportsEnsure?: boolean;
  /** Private worker launch contract, separate from ordinary session creation. */
  supportsWorkers?: boolean;
  supportsWorkerStopAttestation?: boolean;
  supportsStructuredResults?: boolean;
  supportsProfiles?: boolean;
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
  /** Durably queued for the next turn boundary; not submitted or accepted yet. */
  queued?: boolean;
  /** Submission was attempted or may have occurred; this is not native acceptance. */
  submitted: boolean;
  state: NativeCommandState;
  /** True only after native protocol evidence confirms acceptance. */
  accepted: boolean;
}
/** Removes a message still queued for the next turn. A submitted message is refused: stop the turn. */
export interface NativeSessionCancelParams extends NativeSessionTargetParams {
  commandId: string;
}
export interface NativeSessionCancelResult {
  /** Failed, never submitted, with outcome `cancelled`. A repeated call returns the same receipt. */
  receipt: NativeCommandReceipt;
}
export type NativeCommandState = 'pending' | 'unknown' | 'accepted' | 'failed' | 'completed';
export interface NativeCommandReceipt {
  generation: string;
  commandId: string;
  state: NativeCommandState;
  submitted: boolean;
  accepted: boolean;
  queued?: boolean;
  /** `cancelled`: removed from the queue by `native.session.cancel` before submission. */
  outcome?: 'completed' | 'failed' | 'interrupted' | 'cancelled';
  structuredResult?: NativeStructuredResult;
}

export interface NativeSessionResponse {
  decision?: 'approve' | 'deny';
  answers?: Record<string, string[]>;
}
export interface NativeSessionRespondParams
  extends NativeSessionTargetParams, NativeSessionResponse {
  requestId: string;
}
export interface NativeProcessExitEvidence {
  /** Null when the process exited by signal or its exit was not observed. */
  exitCode: number | null;
  signal: string | null;
  /** Bounded diagnostic tail with credentials removed. */
  stderrTail: string[];
}

export interface NativeSessionInfo extends Partial<NativeProcessExitEvidence> {
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
  processStopReason?: 'process-exit' | 'process-missing' | 'process-missing-attested';
  error?: string;
  recovery?: string;
  runner: string;
  nativeSessionId: string;
  ownerPrincipalId: string;
  executionNodeId: string;
  accountContextId: string;
  profileId?: string;
  cwd: string;
  executable: string;
  version: string;
  model?: string;
  mode: 'default' | 'plan';
  accountMode: 'native';
  resultSchema?: NativeResultSchema;
  effort?: string;
  /** Recovery must rebuild the trusted worker launch configuration through run controls. */
  workerManaged?: boolean;
  /** Current worker task's input lease; independent of process generation and command IDs. */
  workerLeaseId?: string;
  capabilities: NativeSessionCapabilities;
  state: 'starting' | 'idle' | 'waiting' | 'running' | 'closing' | 'closed' | 'failed';
}
export const NativeSessionEventTypes = {
  SESSION_STARTED: 'session.started',
  COMMAND_SUBMITTED: 'command.submitted',
  COMMAND_ACCEPTED: 'command.accepted',
  TURN_STARTED: 'turn.started',
  TEXT_DELTA: 'text.delta',
  TOOL_STARTED: 'tool.started',
  TOOL_COMPLETED: 'tool.completed',
  APPROVAL_REQUESTED: 'approval.requested',
  APPROVAL_RESOLVED: 'approval.resolved',
  QUESTION_REQUESTED: 'question.requested',
  PLAN_UPDATED: 'plan.updated',
  TURN_COMPLETED: 'turn.completed',
  SESSION_CLOSED: 'session.closed',
  ERROR: 'error',
} as const;

/** What a tool call does, normalized by the runner adapter. Absent: an older host, or unknown. */
export type NativeToolKind = 'command' | 'file-edit' | 'file-read' | 'search' | 'web' | 'other';
export interface NativeSessionTool {
  /** The runner's own tool name, such as Bash or commandExecution. */
  name: string;
  input?: unknown;
  output?: unknown;
  status?: string;
  kind?: NativeToolKind;
  /** The command line a `command` tool runs. */
  command?: string;
  /** Files the tool reads, edits or searches. */
  paths?: string[];
}

export interface NativePlanStep {
  text: string;
  status: 'pending' | 'in-progress' | 'completed';
}
/**
 * A runner's plan, normalized by its adapter. Each `plan.updated` carries the whole plan and
 * replaces the earlier plan of the same kind in that turn.
 */
export type NativeSessionPlan =
  /** The runner's working steps, with an optional note. */
  | { kind: 'checklist'; steps: NativePlanStep[]; text?: string }
  /** A plan proposed before acting, as markdown. */
  | { kind: 'proposal'; text: string };

export interface NativeSessionEvent {
  sessionId: string;
  sequence: number;
  generation: string;
  at: string;
  type: (typeof NativeSessionEventTypes)[keyof typeof NativeSessionEventTypes];
  commandId?: string;
  turnId?: string;
  nativeId?: string;
  text?: string;
  tool?: NativeSessionTool;
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
  /**
   * On `approval.resolved`: the response this host delivered for the request. Absent when the
   * runner resolved the request without one, so its decision is unknown.
   */
  response?: NativeSessionResponse;
  /** On `plan.updated`. */
  plan?: NativeSessionPlan;
  status?: 'completed' | 'failed' | 'interrupted';
  /** Only a schema-bound completed provider turn may supply this value. */
  structuredResult?: NativeStructuredResult;
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
  /** Worker events retain absolute session sequences inside this task's lease window. */
  scope?: NativeWorkerHistoryScope;
}

export interface NativeWorkerHistoryScope {
  leaseId: string;
  /** Exclusive first boundary; an omitted read cursor starts here. */
  startAfter: number;
  /** Inclusive last boundary, frozen when the lease transfers. */
  endAt: number;
  released: boolean;
}

/** Curated native choices; availability and billing remain account-owned. */
export interface NativeRunnerOption {
  runner: string;
  models: string[];
  defaultModel: string;
  modes: Array<'default' | 'plan'>;
  /** Task dispatch and leased recovery are available in addition to standalone chat. */
  supportsWorkers?: boolean;
  /** Queued creation preserves the authenticated profile owner and transport. */
  supportsQueuedWorkers?: boolean;
  /** Managed static reviews enforce a read-only checkout without leasing an app slot. */
  supportsWorkspaceReviews?: boolean;
}
export interface NativeSessionCatalogResult {
  runners: NativeRunnerOption[];
  contexts: Array<{
    cwd: string;
    label: string;
    slotId?: string;
    project?: string;
    executionNodeId?: string;
    supportsProfiles?: boolean;
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
