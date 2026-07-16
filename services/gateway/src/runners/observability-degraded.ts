// observability-degraded.ts — ADR-032 Phase 3A degraded-mode policy (pane-retired flag).
//
// When the pane-retirement flag is on and a runner's hook signal is unavailable/stale, the
// send path cannot fall back to the pane. Rather than silently sending into a blind composer
// or silently aborting, we resolve conservatively to busy and emit an ADR-031 deterministic
// recovery action (a "hold-send" hold) plus an attention reason the slot health surface reads.

import type { ObservabilityReading, RunnerActivity } from './observability-types.js';

export const OBSERVABILITY_DEGRADED_ATTENTION_REASON = 'observability-degraded' as const;

/**
 * An activity reading is degraded (no authoritative hook signal) when it is absent,
 * low-confidence, or resolves to `unknown`. This is the exact set of cases where Phase 2
 * (flag-off) would consult the pane — under the flag those cases hold the send instead.
 */
export function isObservabilityDegraded(
  reading: ObservabilityReading<RunnerActivity> | null | undefined,
): boolean {
  if (!reading) return true;
  if (reading.confidence === 'low') return true;
  return reading.value === 'unknown';
}

/** ADR-031 deterministic-recovery action for an observability-degraded hold. */
export interface ObservabilityDegradedRecoveryAction {
  kind: 'observability-degraded';
  tier: 'deterministic';
  /** Conservative hold: never send into a blind composer; wait for hooks to recover. */
  action: 'hold-send';
  slotId: string;
  runner: string;
  target: string;
  attentionReason: typeof OBSERVABILITY_DEGRADED_ATTENTION_REASON;
  reason: string;
  timestamp: number;
}

export function buildObservabilityDegradedRecovery(params: {
  slotId: string;
  runner: string;
  target: string;
  now: number;
  reason?: string;
}): ObservabilityDegradedRecoveryAction {
  return {
    kind: 'observability-degraded',
    tier: 'deterministic',
    action: 'hold-send',
    slotId: params.slotId,
    runner: params.runner,
    target: params.target,
    attentionReason: OBSERVABILITY_DEGRADED_ATTENTION_REASON,
    reason:
      params.reason ??
      'hook signal unavailable/stale under pane-retired flag; holding send and requesting attention',
    timestamp: params.now,
  };
}

export function logObservabilityDegradedRecovery(
  action: ObservabilityDegradedRecoveryAction,
  logPrefix: string,
): void {
  console.warn(
    `[${logPrefix}] [observability] degraded — ${JSON.stringify({
      ...action,
      record: 'observability-degraded-recovery',
    })}`,
  );
}
