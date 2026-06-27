import { runnerActivityIsBusy } from './observability-files.js';
import type {
  ObservabilityConfidence,
  ObservabilityReading,
  RunnerActivity,
} from './observability-types.js';

/** Hook-path busy poll — sub-second signal vs 1.5s pane scrape cadence. */
export const RUNNER_HOOK_SAFE_SEND_TIMEOUT_MS = 10_000;

/** Pane-only runners and observability fallback paths. */
export const RUNNER_PANE_SAFE_SEND_TIMEOUT_MS = 30_000;

export function isObservabilityReadingAuthoritative<T>(
  reading: ObservabilityReading<T> | null | undefined,
): reading is ObservabilityReading<T> {
  if (!reading) return false;
  if (reading.confidence === 'low') return false;
  return true;
}

export function selectBusyFromObservabilityAndPane(
  hookReading: ObservabilityReading<RunnerActivity> | null | undefined,
  paneBusy: boolean,
): { busy: boolean; source: 'hook' | 'pane'; confidence: ObservabilityConfidence | null } {
  if (
    isObservabilityReadingAuthoritative(hookReading) &&
    hookReading.value !== 'unknown'
  ) {
    return {
      busy: runnerActivityIsBusy(hookReading.value),
      source: 'hook',
      confidence: hookReading.confidence,
    };
  }
  return { busy: paneBusy, source: 'pane', confidence: null };
}

export function selectPendingFromObservabilityAndPane(
  promptReading: ObservabilityReading<boolean> | null | undefined,
  panePending: boolean,
): { pending: boolean; source: 'hook' | 'pane'; confidence: ObservabilityConfidence | null } {
  // Live composer state wins when hooks report an older accepted digest but the
  // instruction is still buffered — prevents duplicate send-keys on re-nudge.
  if (panePending) {
    if (isObservabilityReadingAuthoritative(promptReading) && promptReading.value === false) {
      return { pending: true, source: 'hook', confidence: promptReading.confidence };
    }
    return { pending: true, source: 'pane', confidence: null };
  }
  if (isObservabilityReadingAuthoritative(promptReading)) {
    return {
      pending: false,
      source: 'hook',
      confidence: promptReading.confidence,
    };
  }
  return { pending: false, source: 'pane', confidence: null };
}