import type { loadSlotVars } from '../core/config.js';

export type ObservabilitySource = 'hook' | 'statusline' | 'signal' | 'pane' | 'unknown';
export type ObservabilityConfidence = 'high' | 'medium' | 'low';

export interface ObservabilityReading<T> {
  value: T;
  source: ObservabilitySource;
  confidence: ObservabilityConfidence;
  /** ms since epoch of the underlying event/file mtime. */
  observedAt: number;
  /** True only when prompt-acceptance evidence matched the requested prompt itself. */
  exactPromptMatch?: boolean;
  /** Persisted runner session that emitted the reading, when the provider exposes it. */
  sessionId?: string;
  /** Stable identity of the runner turn that emitted the reading. */
  turnToken?: string;
}

export type RunnerActivity = 'idle' | 'composing' | 'tool-running' | 'awaiting-input' | 'unknown';
export type RunnerSessionDeliveryState = 'idle' | 'active' | 'unknown';

export type ObservabilityScope = 'event-driven' | 'pane-only' | 'none';

export type SlotVars = Awaited<ReturnType<typeof loadSlotVars>>;

export interface HookRecord {
  schemaVersion?: number;
  observedAt?: number;
  observed_at?: number;
  timestamp?: number;
  hook_event_name?: string;
  event?: string;
  tool_name?: string;
  notification_type?: string;
  source?: string;
  tool_use_id?: string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  runnerPromptDigest?: string;
  turnStartedAt?: number;
  turnActive?: boolean;
  /** Root runner session currently owning the tmux pane. */
  rootSessionId?: string;
  sentAt?: number;
  tmuxPane?: string;
  slotId?: string;
}

export interface StatuslineRecord {
  schemaVersion?: number;
  observedAt?: number;
  observed_at?: number;
  timestamp?: number;
  mtime?: number;
  busy?: boolean;
  model?: string;
  ctxPct?: number;
  contextPct?: number;
  tmuxPane?: string;
}

export interface RunnerObservability {
  /** How this provider proves that the exact prompt was accepted. */
  promptAcceptanceMode?: 'hook-digest' | 'native-text';
  getActivity(vars: SlotVars, target: string): Promise<ObservabilityReading<RunnerActivity> | null>;
  /**
   * Durable state of the whole runner turn currently bound to a tmux target.
   * Unlike transient activity, an active turn remains active across a long tool
   * call until the runner emits its terminal turn event.
   */
  getTurnState?(
    vars: SlotVars,
    target: string,
    /** Exact leased turn to resolve when pane snapshots may be owned by a child session. */
    expectedTurnToken?: string,
  ): Promise<ObservabilityReading<RunnerSessionDeliveryState> | null>;
  getContextPct(vars: SlotVars, target: string): Promise<ObservabilityReading<number> | null>;
  activeTool(vars: SlotVars, target: string): Promise<ObservabilityReading<string> | null>;
  lastTurnCompletedAt(vars: SlotVars, target: string): Promise<ObservabilityReading<number> | null>;
  /**
   * Capture the provider's own clock immediately before prompt delivery. Native
   * session histories must compare against this baseline instead of the
   * gateway clock because fleet nodes can be skewed.
   */
  capturePromptAcceptanceBaseline?(vars: SlotVars, target: string): Promise<number>;
  /** Resolve the runner-native session id stored inside one persisted session. */
  resolveSessionId?(vars: SlotVars, sessionPath: string): Promise<string | null>;
  /** Resolve the exact native session currently owned by one tmux target. */
  getSessionBinding?(
    vars: SlotVars,
    target: string,
    /** Current exact pane-process start; providers must not bind older session activity. */
    observedNotBeforeMs?: number,
  ): Promise<{
    sessionId: string;
    sessionPath: string;
    observedAt: number;
  } | null>;
  /**
   * Upgrade one persisted binding to the runner's current native identity.
   * Providers must reject ids that are neither current nor a format they
   * previously persisted; callers fail closed when normalization rejects it.
   */
  normalizeRetainedSessionBinding?(
    vars: SlotVars,
    binding: { sessionId: string; sessionPath: string },
  ): Promise<{ sessionId: string; sessionPath: string } | null>;
  promptAccepted(
    vars: SlotVars,
    target: string,
    promptDigest: string,
    sinceMs: number,
    // ADR-032 Phase 3A: when true (pane-retired send path), absent hooks resolve to null
    // (non-authoritative → degrade/hold) instead of main's medium-`false`. Default false keeps
    // Phase-2 flag-off behavior byte-identical.
    paneRetired?: boolean,
    /** Exact prompt text for native providers whose session protocol exposes it. */
    promptText?: string,
  ): Promise<ObservabilityReading<boolean> | null>;
  /** Exact prompt acceptance from one persisted runner-native session history. */
  promptAcceptedInSession?(
    vars: SlotVars,
    target: string,
    sessionId: string,
    sessionPath: string,
    promptText: string,
    sinceMs: number,
  ): Promise<ObservabilityReading<boolean> | null>;
  /**
   * Durable delivery state for one persisted runner session. Unlike transient
   * activity, a terminal Stop remains idle until a later event in that same
   * session supersedes it.
   */
  getSessionDeliveryState(
    vars: SlotVars,
    target: string,
    sessionId: string,
    sessionPath: string,
  ): Promise<ObservabilityReading<RunnerSessionDeliveryState> | null>;
}
