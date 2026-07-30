import type { loadSlotVars } from '../core/config.js';

export type ObservabilitySource = 'hook' | 'statusline' | 'signal' | 'pane' | 'unknown';
export type ObservabilityConfidence = 'high' | 'medium' | 'low';

export interface ObservabilityReading<T> {
  value: T;
  source: ObservabilitySource;
  confidence: ObservabilityConfidence;
  /** ms since epoch of the underlying event/file mtime. */
  observedAt: number;
}

export type RunnerActivity = 'idle' | 'composing' | 'tool-running' | 'awaiting-input' | 'unknown';

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
  getActivity(vars: SlotVars, target: string): Promise<ObservabilityReading<RunnerActivity> | null>;
  getContextPct(vars: SlotVars, target: string): Promise<ObservabilityReading<number> | null>;
  activeTool(vars: SlotVars, target: string): Promise<ObservabilityReading<string> | null>;
  lastTurnCompletedAt(vars: SlotVars, target: string): Promise<ObservabilityReading<number> | null>;
  promptAccepted(
    vars: SlotVars,
    target: string,
    promptDigest: string,
    sinceMs: number,
    // ADR-032 Phase 3A: when true (pane-retired send path), absent hooks resolve to null
    // (non-authoritative → degrade/hold) instead of main's medium-`false`. Default false keeps
    // Phase-2 flag-off behavior byte-identical.
    paneRetired?: boolean,
  ): Promise<ObservabilityReading<boolean> | null>;
}
