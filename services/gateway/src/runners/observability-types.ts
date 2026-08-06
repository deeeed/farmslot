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
  tool_use_id?: string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  runnerPromptDigest?: string;
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
