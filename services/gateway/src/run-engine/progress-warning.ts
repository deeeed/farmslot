import type { RunStep } from '@farmslot/protocol';

import type {
  ObservabilityReading,
  RunnerSessionDeliveryState,
} from '../runners/observability-types.js';
import { getRun, updateRunStep } from '../runs/store.js';

export function runnerTokenProgressWarning(
  state: ObservabilityReading<RunnerSessionDeliveryState> | null | undefined,
  now = Date.now(),
): string | null {
  const since = state?.lastTokenProgressAt;
  if (
    !state ||
    state.confidence !== 'high' ||
    state.source === 'pane' ||
    state.source === 'unknown' ||
    state.value !== 'active' ||
    typeof since !== 'number' ||
    !Number.isFinite(since) ||
    now - since < 5 * 60_000
  )
    return null;
  return `Worker token usage has not advanced for ${Math.floor((now - since) / 60_000)} minutes`;
}

/** Annotate the existing observation, without more node polls, nudges or decisions. */
export function reportRunnerProgressWarning(
  runId: string,
  stepName: RunStep['name'],
  state: ObservabilityReading<RunnerSessionDeliveryState> | null | undefined,
  now = Date.now(),
): boolean {
  const warning = runnerTokenProgressWarning(state, now);
  const step = getRun(runId)?.steps.find(({ name }) => name === stepName);
  const previous = step?.outputs?.runnerProgressWarning;
  if (!step || (!warning && !previous) || previous === warning) return false;
  updateRunStep(runId, stepName, {
    detail: warning ?? (step.detail === previous ? undefined : step.detail),
    outputs: { ...step.outputs, runnerProgressWarning: warning },
  });
  return true;
}
