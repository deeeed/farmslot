export type SlotAgent = 'idle' | 'working' | 'no-tmux';

/** Execution transport is independent of the selected runner and model. */
export type WorkerTransport = 'tmux' | 'native';

export interface NativeWorkerSessionBinding {
  /** Reserved before launch, then used by native.session.ensure on every retry. */
  sessionId: string;
  executionNodeId: string;
  ownerPrincipalId: string;
  /** Absent until initial creation is reconciled with the native host. */
  generation?: string;
  /** Changes when an idle retained session is transferred to another task. */
  leaseId: string;
  /** Persisted before sending the current task prompt. Reused after uncertain delivery. */
  commandId: string;
  /** Confirmed native acceptance of this task's initial command. */
  acceptedAt?: string;
  /** Private launch settings are represented by a digest, never environment values. */
  launchDigest?: string;
  accountLabel?: string;
  /** Captured before launch and retained across parking, recovery and task handoff. */
  profile?: import('../rpc/native-profile.js').NativeProfileReference;
  /** Execution-host-owned state outside recyclable slot worktrees. Absent for legacy workers. */
  stateDirectory?: string;
  effort?: string;
  safetyTier?: SafetyTier;
  /** Durable intent recorded before the initial native launch request. */
  launchRequestedAt?: string;
  /** A confirmed close allows the slot to be reused by another transport or owner. */
  closedAt?: string;
  /** Advances when an explicit close abandons an uncertain recovery instruction. */
  recoveryEpoch?: number;
  /** The retained process continues under a successor task's lease. */
  releasedAt?: string;
  /** Durable source of an idle-session transfer, retained until reconciliation completes. */
  handoffFrom?: { runId: string; contextId: string; leaseId: string };
  handoffCompletedAt?: string;
  /** Correlates an explicit stopped-worker resume across a lost host reply. */
  recovery?: {
    fromGeneration: string;
    commandId: string;
    requestedAt?: string;
    /** Fix recovery continues the active subtask; an idle recovery waits for fresh findings. */
    contextId?: string;
    text?: string;
    resumeOnly?: boolean;
    /** Continue an operator-held terminal finding without replacing its live process. */
    continueLive?: boolean;
  };
}

/** A pending recovery can own a new process even while the last recorded generation is closed. */
export function nativeWorkerBindingIsHeld(
  binding: NativeWorkerSessionBinding | undefined,
): boolean {
  return Boolean(binding && !binding.releasedAt && (!binding.closedAt || binding.recovery));
}

export const AGENT_ROLES = [
  'primary',
  'dev',
  'fix-bug',
  'review',
  'self-review',
  'self-review-fix',
  'ci-fix',
] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];
export type AgentContextStatus =
  | 'launching'
  | 'working'
  | 'waiting'
  | 'complete'
  | 'failed'
  | 'blocked'
  | 'idle';

export interface AgentContextTarget {
  session: string;
  window?: string | null;
  pane?: string | null;
  /** Stable tmux pane identity (`%N`); required by destructive runner lifecycle operations. */
  paneId?: string | null;
  target: string;
}

/** Recycle snapshot of a runner-owned transcript. Bytes live next to `.runs/`, not in this object. */
export type RunnerSessionArchiveKind = 'jsonl';
export type RunnerSessionArchiveStatus = 'captured' | 'missing' | 'unsupported';

export interface RunnerSessionArchiveRef {
  status: RunnerSessionArchiveStatus;
  kind?: RunnerSessionArchiveKind;
  runner?: string;
  originalPath?: string;
  /** Path under the gateway `.runs/` directory, e.g. `session-archives/<runId>/<contextId>`. */
  relativeDir?: string;
  sha256?: string;
  sizeBytes?: number;
  capturedAt?: string;
  reason?: string;
}

export interface AgentContext {
  id: string;
  role: AgentRole;
  label: string;
  status: AgentContextStatus;
  slotId: string;
  runId: string;
  taskFile?: string | null;
  signalFile?: string | null;
  /** Machine-readable reviewer verdict/issues artifact required for this reviewer attempt. */
  reviewResultFile?: string | null;
  /** Artifact directory scope owned by this reviewer attempt (for restart recovery). */
  artifactScope?: string | null;
  /** Review loop that owns the persisted launch snapshot. */
  reviewLoopNumber?: number | null;
  /** Gateway validation completed for the structured reviewer result and archived artifacts. */
  reviewResultValidatedAt?: string;
  runner?: string | null;
  model?: string | null;
  target?: AgentContextTarget | null;
  /** Native sessions have no tmux target. */
  nativeSession?: NativeWorkerSessionBinding;
  /** Subtask sharing a same-run worker. Session and lease prevent adoption after task replay. */
  nativeSessionOwner?: { contextId: string; sessionId: string; leaseId: string };
  /** Durable instruction identity for a subtask in a shared native conversation. */
  nativeCommandId?: string;
  /** Exact materialized subtask prompt, retained for duplicate-safe delivery recovery. */
  nativeCommandText?: string;
  /** Confirmed closed/released attempts retained when this context is explicitly restarted. */
  nativeSessionHistory?: NativeWorkerSessionBinding[];
  runnerSessionId?: string | null;
  runnerSessionPath?: string | null;
  /**
   * When the runner-layer session hook last bound this role to the id/path pair
   * above. Written only alongside a complete binding, so it also dates the
   * evidence an operator reopens the session from.
   */
  runnerSessionCapturedAt?: string;
  /** Opaque recycle snapshot of this context's runner transcript, when the runner supports it. */
  runnerSessionArchive?: RunnerSessionArchiveRef;
  nudgeCount?: number;
  /** Runner context-window usage percentage (0-100). See {@link AgentContextSummary.ctxPct}. */
  ctxPct?: number | null;
  startedAt?: string;
  /**
   * Launch time of the CURRENT attempt/pass. startedAt survives context reuse
   * (warm reviewer loops keep loop 1's value) and updatedAt is rewritten by
   * startup reconciliation — neither can anchor "did this signal come from the
   * current attempt", which restart recovery needs.
   */
  attemptStartedAt?: string;
  /** Durable boundary recorded immediately before a task prompt may mutate the runner. */
  promptDeliveryStartedAt?: string;
  /** Optional source ref captured with the delivery boundary, such as the pre-fix HEAD. */
  deliveryBaselineRef?: string;
  /** Tmux pane PID captured before a destructive delivery, used to prove whether respawn occurred. */
  deliveryBaselinePanePid?: string;
  /** Attempt identity last observed from the worker signal contract. */
  signalAttemptId?: string;
  updatedAt?: string;
  completedAt?: string;
  lastSignalAt?: string;
}

export interface AgentContextSummary {
  id: string;
  role: AgentRole;
  label: string;
  status: AgentContextStatus;
  runId?: string | null;
  taskFile?: string | null;
  /** Run-relative task identity derived by the gateway, independent of the configured task root. */
  taskIdentity?: string | null;
  signalFile?: string | null;
  runner?: string | null;
  model?: string | null;
  target?: AgentContextTarget | null;
  nativeSession?: NativeWorkerSessionBinding;
  nativeSessionOwner?: AgentContext['nativeSessionOwner'];
  nativeCommandId?: string;
  nudgeCount?: number;
  lastSignalAt?: string;
  /** When present, used to pick the latest reviewer among multiple same-run tabs. */
  updatedAt?: string;
  /** Runner context-window usage percentage (0-100). Runner-agnostic — each runner's node-side
   * adapter is responsible for parsing its own status surface (Claude's `ctx:N%` status line,
   * codex's session metadata, etc.). Null when the runner has not exposed a value or the parse
   * failed. Surfaced for branch-affinity nudge decisions so operators see whether a nudge will
   * trigger a context compact mid-task. */
  ctxPct?: number | null;
}

export interface AgentContextSelector {
  role?: AgentRole;
  contextId?: string;
  target?: string;
}

export type SafetyTier = 'sandboxed' | 'full-auto' | 'dangerous';

export type ScriptedRunnerScenario = 'success' | 'failure' | 'timeout';

export type ScriptedRunnerConfig =
  | {
      mode: 'scenario';
      scenario: ScriptedRunnerScenario;
      stepDelayMs?: number;
    }
  | {
      mode: 'command';
      commandRef: string;
      timeoutMs?: number;
    };

export interface ExecutorRef {
  runner: string;
  model?: string | null;
  scripted?: ScriptedRunnerConfig;
  safetyTier?: SafetyTier;
}

export interface ExecutorPolicy {
  worker?: ExecutorRef;
  selfReview?: ExecutorRef;
  ciRepair?: ExecutorRef;
  validation?: ExecutorRef;
}
