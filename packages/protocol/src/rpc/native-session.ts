import type {
  NativeResultSchema,
  NativeStructuredResult,
} from '../recipe/pipeline-visual-judgments.js';

/** Server-derived audit metadata; never accepted as public launch parameters. */
export interface NativeSessionRequester {
  principalId: string;
  principalGeneration: number;
}

export type NativeApprovalMode = 'ask' | 'bypass';

/** Native sessions are opt-in. Authentication and agent execution remain runner-owned. */
export interface NativeSessionCapabilities {
  modes: Array<'default' | 'plan'>;
  /** Separate from planning. Absent on hosts predating per-session tool policy. */
  approvalModes?: NativeApprovalMode[];
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
  /** Set by the adapter: a send with `delivery: 'steer'` can join the running turn. */
  steer?: boolean;
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
  /** Standalone sessions only. Omitted means ask, or the saved mode when resuming. */
  approvalMode?: NativeApprovalMode;
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

/** Explicit idle-session tool policy change. Worker launch settings remain authoritative. */
export interface NativeSessionSetApprovalModeParams extends NativeSessionTargetParams {
  approvalMode: NativeApprovalMode;
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
  conversationStreaming?: 1;
  /** The node forwards standalone approval settings without dropping them. */
  supportsApprovalMode?: boolean;
  /** The runtime persists server-derived standalone requester attribution. */
  supportsStandaloneDelegation?: boolean;
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
  /**
   * `steer`: add the message to the running turn when the session can take it there
   * (`capabilities.steer`, a running turn, no pending request); otherwise it is sent as usual.
   * An older host refuses it rather than queueing it.
   */
  delivery?: 'steer';
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
  /** Added to the running turn; it completes with that turn. */
  steered?: true;
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
  /** Added to the running turn; it completes with that turn. */
  steered?: true;
  /** `cancelled`: removed from the queue by `native.session.cancel` before submission. */
  outcome?: 'completed' | 'failed' | 'interrupted' | 'cancelled';
  structuredResult?: NativeStructuredResult;
}

/** Passive command metadata, without a transcript page or prompt text. */
export interface NativeCommandObservation {
  session: NativeSessionInfo;
  receipt?: NativeCommandReceipt;
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
  requestedByPrincipalId?: string;
  requestedByPrincipalGeneration?: number;
  executionNodeId: string;
  accountContextId: string;
  profileId?: string;
  cwd: string;
  executable: string;
  version: string;
  model?: string;
  mode: 'default' | 'plan';
  accountMode: 'native';
  /** Absent on older journals, whose policy is ask. Workers keep their launch policy. */
  approvalMode?: NativeApprovalMode;
  /** A timed-out native setter blocks input until the setting is explicitly confirmed. */
  approvalModePending?: NativeApprovalMode;
  resultSchema?: NativeResultSchema;
  effort?: string;
  /** Recovery must rebuild the trusted worker launch configuration through run controls. */
  workerManaged?: boolean;
  /** Current worker task's input lease; independent of process generation and command IDs. */
  workerLeaseId?: string;
  /** Effective question-tool setting of this worker process; absent on older hosts. */
  workerModelQuestions?: 'on' | 'off';
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
  TURN_CHANGES: 'turn.changes',
  SESSION_CLOSED: 'session.closed',
  ERROR: 'error',
} as const;

/** What a tool call does, normalized by the runner adapter. Absent: an older host, or unknown. */
export type NativeToolKind = 'command' | 'file-edit' | 'file-read' | 'search' | 'web' | 'other';
/** Generic file-edit content, normalized by the adapter rather than either renderer. */
export interface NativeToolDiff {
  path: string;
  /** Null means the tool created the file. */
  oldText: string | null;
  newText: string;
}

export interface NativeSessionTool {
  /** The runner's own tool name, such as Bash or commandExecution. */
  name: string;
  input?: unknown;
  output?: unknown;
  diffs?: NativeToolDiff[];
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
export interface NativeTurnFile {
  /** Relative to the repository root. */
  path: string;
  status: 'added' | 'modified' | 'deleted';
  /** Absent for a binary file. */
  additions?: number;
  deletions?: number;
}
/**
 * What a turn changed in the session's Git working tree: the host's checkpoints before and after
 * it (`from`, `to`) and the files that differ. `unavailable` says why there are none to show.
 */
export interface NativeTurnChanges {
  from?: string;
  to?: string;
  files: NativeTurnFile[];
  /** More files changed than are listed. */
  truncated?: boolean;
  unavailable?: string;
}

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
  /** On `turn.changes`, for the turn of `commandId`. */
  changes?: NativeTurnChanges;
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
  /**
   * Per-node catalogs (Pi, OpenCode): the models each execution node lists, keyed like a
   * context's `executionNodeId`. A node with no entry has not listed yet and uses `models`.
   */
  nodeModels?: Record<string, string[]>;
  defaultModel: string;
  efforts?: string[];
  defaultEffort?: string | null;
  modes: Array<'default' | 'plan'>;
  /** Task dispatch and leased recovery are available in addition to standalone chat. */
  supportsWorkers?: boolean;
  /** Queued creation preserves the authenticated profile owner and transport. */
  supportsQueuedWorkers?: boolean;
  /** Managed static reviews enforce a read-only checkout without leasing an app slot. */
  supportsWorkspaceReviews?: boolean;
}

/** The models a new session on `executionNodeId` can choose. */
export function nativeRunnerModels(
  option: Pick<NativeRunnerOption, 'models' | 'nodeModels'>,
  executionNodeId?: string,
): string[] {
  return (executionNodeId && option.nodeModels?.[executionNodeId]) || option.models;
}

/** Keep the default within a known node's listing, including saved global defaults. */
export function nativeRunnerDefaultModel(
  option: Pick<NativeRunnerOption, 'models' | 'nodeModels' | 'defaultModel'>,
  executionNodeId?: string,
): string {
  const listed = executionNodeId && option.nodeModels?.[executionNodeId];
  return listed && !listed.includes(option.defaultModel) ? (listed[0] ?? '') : option.defaultModel;
}
export interface NativeSessionExecutionNode {
  executionNodeId: string;
  label: string;
  /** Current target home; unknown while unavailable, never a username-derived guess. */
  homeDirectory?: string;
  /** Present rows cannot launch, even when they retain a previous home value. */
  unavailableReason?: string;
}
export interface NativeSessionCatalogResult {
  executionNodes?: NativeSessionExecutionNode[];
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
  /** False for a directory outside a Git work tree; files remain browsable. */
  repository?: boolean;
  files: Array<{ path: string; status: string }>;
  truncated?: boolean;
}
/** One file's diff between a turn's checkpoints: the `turn.changes` event at `sequence`. */
export interface NativeSessionTurnDiffParams extends NativeSessionTargetParams {
  sequence: number;
  /** One of that event's `files`. */
  path: string;
}
export interface NativeSessionTurnDiffResult {
  path: string;
  diff: string;
}
export interface NativeWorkspaceReadResult {
  path: string;
  content: string;
}
export interface NativeWorkspaceDiffResult {
  path: string;
  diff: string;
}

/** A durable source boundary. Worker pins never follow a successor lease. */
export interface NativeConversationCursor extends NativeSessionTargetParams {
  executionNodeId: string;
  /** A new detached host cannot splice a previous host's feed. */
  hostGeneration: string;
  generation: string;
  sequence: number;
}
export interface NativeSessionSubscribeParams extends NativeSessionTargetParams {
  after?: NativeConversationCursor;
}
export interface NativeConversationOmission {
  /** Projection row retaining the prefix. All omitted bytes remain in the authorized journal. */
  anchorSequence: number;
  after: number;
  through: number;
}
export interface NativeConversationPage extends NativeSessionReadResult {
  /** Metadata exceeding the stream budget remains available through an explicit
   * native.session.read of this same authorized target. Never auto-poll it. */
  metadataOmitted?: { commands: number; pendingRequests: number };
}
export interface NativeConversationReset extends NativeConversationPage {
  omissions?: NativeConversationOmission[];
  /** Read older original events with native.session.read, up to this boundary. */
  historyBefore: number;
  truncated: boolean;
  /** An oversized active segment continues in authorized journal pages after this sequence. */
  activePrefixAfter?: number;
}
export interface NativeConversationDeltaPage {
  events: NativeSessionEvent[];
  cursor: number;
  session?: NativeSessionInfo;
  commands?: NativeCommandReceipt[];
  pendingRequests?: NativeSessionEvent[];
  scope?: NativeWorkerHistoryScope;
  /** Null clears a previous omission notice. */
  metadataOmitted?: NativeConversationPage['metadataOmitted'] | null;
}
export type NativeConversationUpdate =
  | { kind: 'reset'; cursor: NativeConversationCursor; snapshot: NativeConversationReset }
  | { kind: 'replay'; cursor: NativeConversationCursor; page: NativeConversationPage }
  | { kind: 'delta'; cursor: NativeConversationCursor; page: NativeConversationDeltaPage }
  | { kind: 'terminal'; reason: 'resync-required' | 'source-unavailable' | 'access-denied' };
export type NativeConversationInitial = Exclude<NativeConversationUpdate, { kind: 'delta' }>;
export type NativeSessionSubscribeResult = NativeConversationInitial & { subscriptionId: string };
export type NativeSessionDeltaPayload = NativeConversationUpdate & { subscriptionId: string };
export interface NativeSessionUnsubscribeParams {
  subscriptionId: string;
}

export const NATIVE_CONVERSATION_LIMITS = {
  projectionRows: 400,
  projectionBytes: 832 * 1024,
  replayEvents: 128,
  frameBytes: 1024 * 1024,
  textBytes: 64 * 1024,
  flushMs: 50,
} as const;
