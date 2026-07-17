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
 * Only an authoritative, non-`unknown` reading yields a `hookBusy` decision; `unknown`/absent/
 * low-confidence readings keep `hookBusy` null so `wouldConsultPane` reflects the Phase 2 pane
 * consult the flag replaced (ADR-032 Phase 3A soak metric). Raw activity/source/confidence/
 * observedAt are still recorded for every reading.
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
  const hookAuthoritative =
    reading != null && isObservabilityReadingAuthoritative(reading) && reading.value !== 'unknown';
  const hookActivity = reading?.value ?? null;
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
    ...(wouldConsultPane ? { wouldConsultPane: true } : {}),
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
