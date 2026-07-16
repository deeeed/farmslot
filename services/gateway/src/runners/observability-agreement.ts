import { appendRunnerObservabilityAgreement } from './observability-agreement-log.js';
import type { RunnerActivity } from './observability-types.js';

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
