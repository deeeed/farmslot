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

/**
 * ADR-032 Phase 3A dark-launch switch. When set (`1`/`true`), event-driven runners
 * (Claude/Codex) resolve send/idle/pending decisions from hook readings ONLY — pane
 * predicates are never consulted for the decision. Default OFF; when off the selectors
 * behave byte-identically to Phase 2 (pane fallback on hook `unknown`/`null`/low).
 */
export const OBS_PANE_RETIRED_ENV = 'FARMSLOT_OBS_PANE_RETIRED';

export function paneRetiredFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[OBS_PANE_RETIRED_ENV];
  return raw === '1' || raw?.toLowerCase() === 'true';
}

/**
 * A send-decision outcome. `source: 'degraded'` marks the ADR-032 Phase 3A case where the
 * pane retirement flag is on but the hook reading is `unknown`/`null`/low — there is no
 * authoritative signal and the pane is deliberately not consulted, so the decision resolves
 * conservatively to busy (never send into a blind composer).
 */
export type SendDecisionSource = 'hook' | 'pane' | 'degraded';

export function computePromptAcceptedSinceMs(
  loopStartMs: number,
  effectiveTimeoutMs: number,
): number {
  return loopStartMs - effectiveTimeoutMs;
}

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
  paneRetired = false,
): {
  busy: boolean;
  source: SendDecisionSource;
  confidence: ObservabilityConfidence | null;
  degraded?: boolean;
} {
  if (isObservabilityReadingAuthoritative(hookReading) && hookReading.value !== 'unknown') {
    return {
      busy: runnerActivityIsBusy(hookReading.value),
      source: 'hook',
      confidence: hookReading.confidence,
    };
  }
  // Pane retired: no authoritative hook signal → treat as busy without consulting the pane.
  if (paneRetired) {
    return { busy: true, source: 'degraded', confidence: null, degraded: true };
  }
  return { busy: paneBusy, source: 'pane', confidence: null };
}

export function selectIdleFromObservabilityAndPane(
  hookReading: ObservabilityReading<RunnerActivity> | null | undefined,
  paneIdle: boolean,
  paneRetired = false,
): {
  idle: boolean;
  source: SendDecisionSource;
  confidence: ObservabilityConfidence | null;
  degraded?: boolean;
} {
  if (isObservabilityReadingAuthoritative(hookReading) && hookReading.value !== 'unknown') {
    return {
      idle: !runnerActivityIsBusy(hookReading.value),
      source: 'hook',
      confidence: hookReading.confidence,
    };
  }
  // Pane retired: no authoritative hook signal → not idle (busy) without consulting the pane.
  if (paneRetired) {
    return { idle: false, source: 'degraded', confidence: null, degraded: true };
  }
  return { idle: paneIdle, source: 'pane', confidence: null };
}

export function selectPendingFromObservabilityAndPane(
  promptReading: ObservabilityReading<boolean> | null | undefined,
  panePending: boolean,
  paneRetired = false,
): {
  pending: boolean;
  source: SendDecisionSource;
  confidence: ObservabilityConfidence | null;
  degraded?: boolean;
} {
  // Pane retired: hook is the only signal. An authoritative reading decides; anything
  // else is degraded (busy/no-send), and the live-composer pane arg is never consulted.
  if (paneRetired) {
    if (isObservabilityReadingAuthoritative(promptReading)) {
      return {
        pending: !promptReading.value,
        source: 'hook',
        confidence: promptReading.confidence,
      };
    }
    return { pending: false, source: 'degraded', confidence: null, degraded: true };
  }
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
