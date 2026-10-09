import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import { Methods, type Run } from '@farmslot/protocol';

import { RUN_ARCHIVE_TIMEOUT_MS } from '../../utils/resource-operation-timeout.js';

const requests: Array<{ method: string; params: unknown; timeout?: number }> = [];
mock.module('../../gateway-client.js', {
  namedExports: {
    gateway: {
      request: async (method: string, params: unknown, timeout?: number) => {
        requests.push({ method, params, timeout });
        return { ok: true };
      },
    },
  },
});
mock.module('../shared/slot-prepare-client.js', {
  namedExports: { navigateToPreparedSlot: () => {}, runSlotPrepareForRun: async () => {} },
});
const { confirmRunLifecycleAction } = await import('./run-detail-actions.js');

test('archive waits as long as a slot release, since it may release the run slot', async () => {
  let navigated = false;
  await confirmRunLifecycleAction({ id: 'run-1' } as Run, 'archive', {
    actionsBlocked: () => false,
    pendingConfirm: () => 'archive:run-1',
    setPendingConfirm: () => {},
    confirmTimer: () => undefined,
    setConfirmTimer: () => {},
    navigateToRuns: () => (navigated = true),
  });

  assert.deepEqual(requests, [
    { method: Methods.RUN_ARCHIVE, params: { runId: 'run-1' }, timeout: RUN_ARCHIVE_TIMEOUT_MS },
  ]);
  assert.equal(navigated, true);
});
