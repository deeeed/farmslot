import { isObservabilityReadingAuthoritative } from './observability-send-decision.js';
import type {
  ObservabilityReading,
  RunnerActivity,
  RunnerSessionDeliveryState,
  SlotVars,
} from './observability-types.js';
import { readRunnerActivityFromObservability, readRunnerTurnState } from './registry.js';

/**
 * Monitor progress from the runner contract, never from TUI text.
 *
 * Pane glyphs, token footers, and follow-up overlays are not proof that a turn
 * is alive or stuck. Event-driven runners expose getActivity / getTurnState.
 * Pane-only runners (Cursor) have no structured activity provider — unknown
 * activity fails closed (no stuck nudge) instead of scraping the composer.
 */
export type MonitorProgressKind = 'making-progress' | 'idle' | 'awaiting-input' | 'unproven';

export function classifyMonitorProgress(opts: {
  activity: ObservabilityReading<RunnerActivity> | null | undefined;
  turnState?: ObservabilityReading<RunnerSessionDeliveryState> | null;
}): MonitorProgressKind {
  const turn = opts.turnState;
  if (isObservabilityReadingAuthoritative(turn) && turn.value === 'active') {
    return 'making-progress';
  }

  const activity = opts.activity;
  if (isObservabilityReadingAuthoritative(activity) && activity.value !== 'unknown') {
    if (activity.value === 'composing' || activity.value === 'tool-running') {
      return 'making-progress';
    }
    if (activity.value === 'awaiting-input') return 'awaiting-input';
    if (activity.value === 'idle') return 'idle';
  }

  // Durable turn idle still counts after the activity heartbeat expires
  // (Codex/Claude at a prompt with stale statusline). Unknown turn+activity
  // stays unproven (Cursor pane-only).
  if (isObservabilityReadingAuthoritative(turn) && turn.value === 'idle') {
    return 'idle';
  }
  return 'unproven';
}

export function resolveMonitorStuckState(opts: {
  now: number;
  lastProgressAt: number;
  stuckTimeoutMs: number;
  activity: ObservabilityReading<RunnerActivity> | null | undefined;
  turnState?: ObservabilityReading<RunnerSessionDeliveryState> | null;
}): {
  kind: MonitorProgressKind;
  lastProgressAt: number;
  stuck: boolean;
} {
  const kind = classifyMonitorProgress(opts);
  const lastProgressAt = kind === 'making-progress' ? opts.now : opts.lastProgressAt;
  if (kind === 'making-progress' || kind === 'unproven') {
    return { kind, lastProgressAt, stuck: false };
  }
  return {
    kind,
    lastProgressAt,
    stuck: opts.now - lastProgressAt > opts.stuckTimeoutMs,
  };
}

/** Stuck nudges only when the runner contract proved the turn is idle. */
export function shouldDeliverStuckNudge(kind: MonitorProgressKind): boolean {
  return kind === 'idle';
}

/**
 * Production stuck verdict used by run-monitor. Live runner-validation must call
 * this rather than re-deriving pane heuristics.
 */
export async function evaluateMonitorStuckForRunner(opts: {
  vars: SlotVars;
  target: string;
  runner?: string | null;
  now?: number;
  lastProgressAt: number;
  stuckTimeoutMs: number;
}): Promise<{
  kind: MonitorProgressKind;
  lastProgressAt: number;
  stuck: boolean;
  wouldNudge: boolean;
  activity: ObservabilityReading<RunnerActivity> | null;
  turnState: ObservabilityReading<RunnerSessionDeliveryState> | null;
}> {
  const now = opts.now ?? Date.now();
  const runner = opts.runner ?? '';
  const [activity, turnState] = runner
    ? await Promise.all([
        readRunnerActivityFromObservability(opts.vars, opts.target, runner),
        readRunnerTurnState(opts.vars, opts.target, runner),
      ])
    : [null, null];
  const state = resolveMonitorStuckState({
    now,
    lastProgressAt: opts.lastProgressAt,
    stuckTimeoutMs: opts.stuckTimeoutMs,
    activity,
    turnState,
  });
  return {
    ...state,
    wouldNudge: state.stuck && shouldDeliverStuckNudge(state.kind),
    activity,
    turnState,
  };
}
