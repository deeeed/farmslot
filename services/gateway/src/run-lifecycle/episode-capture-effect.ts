// The run-end episode effect (ADR-039 Amendment 4), shared by every terminal plan.

import { captureRunEpisode } from '../run-completion/run-episode.js';

import type { RunTransitionEffect } from './transition-router.js';

/**
 * Advisory and last, after `backlog-settle` and the slot teardown: an episode is
 * history, so it never delays the slot, and its failure never blocks or reverts
 * a terminal state. The hourly retention pass captures any run this one missed.
 */
export const episodeCaptureEffect: RunTransitionEffect = {
  name: 'episode-capture',
  severity: 'advisory',
  apply: async ({ run }) => ((await captureRunEpisode(run)) ? 'ok' : 'skipped'),
};
