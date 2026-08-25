export type SlotAgent = 'idle' | 'working' | 'no-tmux';

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
  runner?: string | null;
  model?: string | null;
  target?: AgentContextTarget | null;
  runnerSessionId?: string | null;
  runnerSessionPath?: string | null;
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
