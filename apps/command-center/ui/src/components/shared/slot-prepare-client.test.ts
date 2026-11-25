import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import { Methods } from '@farmslot/protocol';

const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
mock.module('../../gateway-client.js', {
  namedExports: {
    gateway: {
      request: async (method: string, params: Record<string, unknown>) => {
        requests.push({ method, params });
        return { prepared: true, requestId: String(params.requestId) };
      },
    },
  },
});
mock.module('./slot-prepare-tracker.js', {
  namedExports: { beginSlotPrepareSession: () => {}, scheduleSlotPrepareSessionClear: () => {} },
});
const { runSlotPrepareForRun } = await import('./slot-prepare-client.js');

// A prepare for a run carries the run's flow type and domain, which prepare reads for start refs,
// lockfile drift, requirement selection and the hook env.
test('a prepare for a run sends the run flow type and domain', async () => {
  requests.length = 0;
  await runSlotPrepareForRun({
    slotId: 'slot-1',
    runId: 'run-1',
    branch: 'feat/x',
    slotBranch: 'main',
    flowType: 'dev',
    domain: 'perps',
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.method, Methods.SLOT_PREPARE);
  assert.equal(requests[0]?.params.runId, 'run-1');
  assert.equal(requests[0]?.params.flowType, 'dev');
  assert.equal(requests[0]?.params.domain, 'perps');
});

test('a prepare for a run without a known flow or domain sends neither', async () => {
  requests.length = 0;
  await runSlotPrepareForRun({ slotId: 'slot-1', runId: 'run-1', branch: 'feat/x', slotBranch: 'main' });
  assert.equal('flowType' in (requests[0]?.params ?? {}), false);
  assert.equal('domain' in (requests[0]?.params ?? {}), false);
});
