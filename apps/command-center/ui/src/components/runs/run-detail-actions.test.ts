import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import { Methods, type Run } from '@farmslot/protocol';

import { SLOT_OPERATION_TIMEOUT_MS } from '../../utils/resource-operation-timeout.js';

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
const { confirmRunLifecycleAction, refreshRunEvidence } = await import('./run-detail-actions.js');

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
    { method: Methods.RUN_ARCHIVE, params: { runId: 'run-1' }, timeout: SLOT_OPERATION_TIMEOUT_MS },
  ]);
  assert.equal(navigated, true);
});

test('delete waits as long as a slot release, since a cancelled run releases its kept slot', async () => {
  requests.length = 0;
  let navigated = false;
  await confirmRunLifecycleAction({ id: 'run-1' } as Run, 'delete', {
    actionsBlocked: () => false,
    pendingConfirm: () => 'delete:run-1',
    setPendingConfirm: () => {},
    confirmTimer: () => undefined,
    setConfirmTimer: () => {},
    navigateToRuns: () => (navigated = true),
  });

  assert.deepEqual(requests, [
    { method: Methods.RUN_DELETE, params: { runId: 'run-1' }, timeout: SLOT_OPERATION_TIMEOUT_MS },
  ]);
  assert.equal(navigated, true);
});

// F313: a release no longer copies evidence back, so the run page pulls it again on request.
test('refresh evidence asks the gateway to mirror the run again, once at a time', async () => {
  requests.length = 0;
  const states: boolean[] = [];
  let inProgress = false;
  const context = {
    actionsBlocked: () => false,
    refreshInProgress: () => inProgress,
    setRefreshInProgress: (value: boolean) => {
      inProgress = value;
      states.push(value);
    },
  };
  await Promise.all([refreshRunEvidence('run-1', context), refreshRunEvidence('run-1', context)]);

  assert.deepEqual(requests, [
    {
      method: Methods.RUN_REFRESH_MIRROR,
      params: { runId: 'run-1' },
      timeout: SLOT_OPERATION_TIMEOUT_MS,
    },
  ]);
  assert.deepEqual(states, [true, false]);
});
