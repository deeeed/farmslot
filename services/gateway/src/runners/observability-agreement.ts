import { appendRunnerObservabilityAgreement } from './observability-agreement-log.js';
import { runnerActivityIsBusy } from './observability-files.js';
import { isObservabilityReadingAuthoritative } from './observability-send-decision.js';
import type { ObservabilityReading, RunnerActivity } from './observability-types.js';

export interface RunnerObservabilityAgreementEntry {
  slotId: string;
  runner: string;
  target: string;
  logPrefix: string;
  paneBusy: boolean;
  hookBusy: boolean | null;
  hookActivity: RunnerActivity | null;
  hookSource: string | null;
  hookConfidence: string | null;
  hookObservedAt: number | null;
  agreed: boolean | null;
  disagreementReason?: string;
  /** ADR-032 Phase 3A: the pane-retirement flag was on for this decision. */
  paneRetired?: boolean;
  /**
   * ADR-032 Phase 3A inverted logging: under the flag the hook reading was
   * `unknown`/absent, so Phase 2 (flag-off) would have consulted the pane here.
   * `paneBusy` records what the pane predicate WOULD have returned — the soak
   * window counts these to prove the fallback is dead weight.
   */
  wouldConsultPane?: boolean;
  /**
   * ADR-032 Phase 3A: which hook signal actually degraded this decision. The send loop reads two
   * independent signals (`activity` for busy/idle, `pending` for the composer digest). Recording
   * the one that lapsed keeps the soak metric honest: an authoritative-idle activity paired with a
   * degraded pending signal must log the PENDING reading (else `hookBusy` resolves non-null off the
   * healthy activity read and the `wouldConsultPane` count silently under-reports).
   */
  degradedSignal?: 'activity' | 'pending';
  /** A degraded activity signal recovered through the guarded live-composer check. */
  recoveryOutcome?: 'sent-after-stale-idle';
  timestamp: number;
}

export function disagreementReason(params: {
  paneBusy: boolean;
  hookBusy: boolean | null;
  hookActivity: RunnerActivity | null;
}): string | undefined {
  if (params.hookBusy == null) return 'hook-unavailable';
  if (params.paneBusy === params.hookBusy) return undefined;
  if (params.paneBusy && !params.hookBusy) return 'pane-busy-hook-idle';
  if (!params.paneBusy && params.hookBusy) {
    return params.hookActivity === 'composing'
      ? 'hook-composing-pane-idle'
      : params.hookActivity === 'tool-running'
        ? 'hook-tool-pane-idle'
        : 'hook-busy-pane-idle';
  }
  return 'unknown-mismatch';
}

/**
 * Map a hook activity reading + counterfactual pane state into an agreement log entry.
 *
 * Under the pane-retirement flag (`paneRetired=true`), only an authoritative, non-`unknown`
 * reading yields a `hookBusy` decision; `unknown`/absent/low-confidence readings keep `hookBusy`
 * null so `wouldConsultPane` reflects the Phase 2 pane consult the flag replaced (ADR-032 Phase
 * 3A soak metric).
 *
 * Flag-off (`paneRetired=false`) telemetry also requires an authoritative reading. This prevents a
 * deliberately low-confidence stale-idle recovery signal from being counted as hook agreement;
 * raw activity/source/confidence/observedAt are still recorded for diagnostics.
 */
export function buildRunnerObservabilityAgreementEntry(params: {
  slotId: string;
  runner: string;
  target: string;
  logPrefix: string;
  paneBusy: boolean;
  reading: ObservabilityReading<RunnerActivity> | null;
  paneRetired: boolean;
  timestamp: number;
}): RunnerObservabilityAgreementEntry {
  const { reading } = params;
  const hookActivity = reading?.value ?? null;
  const hookAuthoritative =
    reading != null && isObservabilityReadingAuthoritative(reading) && reading.value !== 'unknown';
  const hookBusy = hookAuthoritative ? runnerActivityIsBusy(reading.value) : null;
  const reason = disagreementReason({ paneBusy: params.paneBusy, hookBusy, hookActivity });
  const wouldConsultPane = params.paneRetired && hookBusy == null;
  return {
    slotId: params.slotId,
    runner: params.runner,
    target: params.target,
    logPrefix: params.logPrefix,
    paneBusy: params.paneBusy,
    hookBusy,
    hookActivity,
    hookSource: reading?.source ?? null,
    hookConfidence: reading?.confidence ?? null,
    hookObservedAt: reading?.observedAt ?? null,
    agreed: hookBusy == null ? null : params.paneBusy === hookBusy,
    ...(reason ? { disagreementReason: reason } : {}),
    ...(params.paneRetired ? { paneRetired: true } : {}),
    ...(wouldConsultPane ? { wouldConsultPane: true, degradedSignal: 'activity' as const } : {}),
    timestamp: params.timestamp,
  };
}

/**
 * ADR-032 Phase 3A: build an agreement entry for a decision that degraded on the PENDING signal
 * (the composer digest read) while the activity read was healthy-idle. It records the prompt
 * reading that actually lapsed — `hookBusy`/`hookActivity` stay null and `wouldConsultPane` is
 * always set, so the soak aggregate counts this decision point instead of masking it behind the
 * authoritative activity read. `paneBusy` carries the counterfactual pane state for the soak
 * window. Always under the flag (this path only exists when the pane is retired).
 */
export function buildPendingDegradedAgreementEntry(params: {
  slotId: string;
  runner: string;
  target: string;
  logPrefix: string;
  paneBusy: boolean;
  promptReading: ObservabilityReading<boolean> | null;
  timestamp: number;
}): RunnerObservabilityAgreementEntry {
  const { promptReading } = params;
  return {
    slotId: params.slotId,
    runner: params.runner,
    target: params.target,
    logPrefix: params.logPrefix,
    paneBusy: params.paneBusy,
    hookBusy: null,
    hookActivity: null,
    hookSource: promptReading?.source ?? null,
    hookConfidence: promptReading?.confidence ?? null,
    hookObservedAt: promptReading?.observedAt ?? null,
    agreed: null,
    disagreementReason: 'hook-unavailable',
    paneRetired: true,
    wouldConsultPane: true,
    degradedSignal: 'pending',
    timestamp: params.timestamp,
  };
}

export function logRunnerObservabilityAgreement(entry: RunnerObservabilityAgreementEntry): void {
  const payload = {
    kind: 'runner-observability-agreement',
    ...entry,
  };
  console.log(`[runner-observability] ${JSON.stringify(payload)}`);
  void appendRunnerObservabilityAgreement(entry).catch((error) => {
    console.warn(
      `[runner-observability] failed to persist agreement log: ${(error as Error).message}`,
    );
  });
}
