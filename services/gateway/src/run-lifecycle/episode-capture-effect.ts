// The run-end episode effect (ADR-039 Amendment 4), shared by every terminal plan.

import { captureRunEpisode } from '../run-completion/run-episode.js';
import { getRun } from '../runs/store.js';

import type { RunTransitionEffect, RunTransitionEffectOutcome } from './transition-router.js';

/** Why an operator completion's transition leaves the episode to its caller. */
export const EPISODE_AFTER_CALLER_RELEASE =
  'the caller releases the slot after this transition and then captures the episode';

/**
 * Advisory and last, after `backlog-settle` and the slot teardown: an episode is
 * history, so it never delays the slot, and its failure never blocks or reverts
 * a terminal state. The hourly retention pass captures any run this one missed.
 *
 * `deferred` names why this transition leaves the capture to its caller: an
 * operator completion releases its slot only after the router returns and its
 * locks are free, so capturing here would run before that teardown and inside
 * those locks. That caller runs {@link captureEpisodeAfterRelease} instead.
 */
export function episodeCaptureEffect(deferred?: string): RunTransitionEffect {
  return {
    name: 'episode-capture',
    severity: 'advisory',
    apply: async ({ run }) => {
      if (deferred) return { status: 'skipped', detail: deferred };
      return (await captureRunEpisode(run)) ? 'ok' : 'skipped';
    },
  };
}

/**
 * An operator completion's capture, once the caller's own slot release is done
 * and its locks are free. Advisory like the effect: a failure is reported and
 * logged, and the hourly retention pass retries it.
 */
export async function captureEpisodeAfterRelease(
  runId: string,
): Promise<RunTransitionEffectOutcome> {
  const run = getRun(runId);
  if (!run) return { name: 'episode-capture', status: 'skipped', detail: 'run not found' };
  try {
    return (await captureRunEpisode(run))
      ? { name: 'episode-capture', status: 'ok' }
      : { name: 'episode-capture', status: 'skipped', detail: 'the run has not ended' };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(`[run-episode] ${runId}: capture after release failed: ${detail}`);
    return { name: 'episode-capture', status: 'failed', detail };
  }
}
