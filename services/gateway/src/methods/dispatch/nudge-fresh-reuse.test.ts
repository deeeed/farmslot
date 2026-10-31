import assert from 'node:assert/strict';
import test from 'node:test';

import { prepareSlotForFreshReuse } from './nudge.js';

test("fresh reuse captures the superseded run's episode only after the old worker is torn down", async () => {
  const order: string[] = [];
  await prepareSlotForFreshReuse('fresh-reuse-episode-slot', 'run-new', {
    terminalize: async () => {
      order.push('terminalize');
      return { priorRunId: 'run-old', terminated: true, episodeRunId: 'run-old' };
    },
    teardown: async () => void order.push('teardown'),
    captureEpisode: async (prior) => void order.push(`episode:${prior.episodeRunId}`),
  });
  assert.deepEqual(order, ['terminalize', 'teardown', 'episode:run-old']);
});
