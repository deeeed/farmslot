// The run-end episode effect (ADR-039 Amendment 4), shared by every terminal plan.

import { captureRunEpisode } from '../run-completion/run-episode.js';

import type { RunTransitionEffect } from './transition-router.js';

/** Why an operator completion's episode waits for the hourly pass. */
export const EPISODE_AFTER_CALLER_RELEASE =
  'the caller releases the slot after this transition; the hourly retention pass captures the episode';

/**
 * Advisory and last, after `backlog-settle` and the slot teardown: an episode is
 * history, so it never delays the slot, and its failure never blocks or reverts
 * a terminal state. The hourly retention pass captures any run this one missed.
 *
 * `deferred` names why this transition leaves the capture to that pass: an
 * operator completion releases its slot only after the router returns and its
 * locks are free, so capturing here would run before that teardown and inside
 * those locks.
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
