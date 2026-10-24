import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import '../runtime/mock-pty.test-support.js';

import * as realState from '../fleet/state.js';

mock.module('../fleet/state.js', {
  namedExports: {
    ...realState,
    loadFleetStatus: async () => ({
      slots: [
        { slot: 'default-local', machine: 'local', enabled: true, branch: 'from-status-owner' },
      ],
    }),
  },
});
const { assertBranchObservationsAdmitted } = await import('./branch-watcher.js');

test('gateway-owned default fleet rows admit without global optional branch watchers', async () => {
  const check = await assertBranchObservationsAdmitted();
  assert.doesNotThrow(check);
});
