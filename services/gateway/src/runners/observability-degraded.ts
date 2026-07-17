// observability-degraded.ts — ADR-032 Phase 3A degraded-mode policy (pane-retired flag).
//
// When the pane-retirement flag is on and a runner's hook signal is unavailable/stale, the
// send path cannot fall back to the pane. Rather than silently sending into a blind composer
// or silently aborting, we resolve conservatively to busy and emit an ADR-031 deterministic
// recovery action (a "hold-send" hold) plus an attention reason the slot health surface reads.

import type { IntelligenceAction } from '@farmslot/protocol';

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

/**
 * ADR-031 intelligence-action record for an observability-degraded hold. Emitting the hold
 * through the deterministic-recovery audit (not just `console.warn`) means the soak review and
 * the run's intelligence timeline both see it: a deterministic-tier action that held the send
 * because the hook signal lapsed under the pane-retirement flag. `runId` is required by the
 * audit contract, so callers without a run context fall back to the console record only.
 */
export function buildObservabilityDegradedIntelligenceAction(params: {
  runId: string;
  now: number;
  runner: string;
  target: string;
  reason: string;
  /**
   * Distinguishes the hold cause in the audit trail: `observability-degraded-hold` for a hook
   * lapse (default), `composer-draft-hold` for a healthy-hook composer draft hold. The soak review
   * counts these separately (Finding #5).
   */
  patternId?: 'observability-degraded-hold' | 'composer-draft-hold';
}): IntelligenceAction {
  const iso = new Date(params.now).toISOString();
  return {
    id: `obs-degraded-${params.runId}-${params.now}`,
    timestamp: iso,
    decidedAt: iso,
    runId: params.runId,
    actor: 'auto-nudge',
    verdict: {
      patternId: params.patternId ?? 'observability-degraded-hold',
      confidence: 'high',
      rationale: params.reason,
    },
    guards: [],
    outcome: 'applied',
    tier: 'deterministic',
    costUsd: 0,
  };
}
