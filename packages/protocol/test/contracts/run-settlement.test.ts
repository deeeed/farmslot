import assert from 'node:assert/strict';
import test from 'node:test';

import { isSettledBlockedRun } from '../../src/contracts/runs.js';

test('isSettledBlockedRun needs blocked status, no running step, no pending decision', () => {
  const resolved = {
    id: 'd1',
    type: 'monitor_interactive_handoff',
    title: 't',
    description: 'd',
    actions: [],
    createdAt: '2026-09-19T00:00:00.000Z',
    resolvedAt: '2026-09-19T00:01:00.000Z',
  };
  const pending = { ...resolved, id: 'd2', resolvedAt: undefined };
  const skipped = [
    { name: 'monitor', status: 'done' as const },
    { name: 'self-review', status: 'skipped' as const },
  ];

  assert.equal(
    isSettledBlockedRun({ status: 'blocked', steps: skipped, decisions: [resolved] }),
    true,
  );
  assert.equal(isSettledBlockedRun({ status: 'blocked', steps: skipped, decisions: [] }), true);
  assert.equal(
    isSettledBlockedRun({ status: 'blocked', steps: skipped, decisions: [pending] }),
    false,
    'a pending decision is a live wait',
  );
  assert.equal(
    isSettledBlockedRun({
      status: 'blocked',
      steps: [{ name: 'human-gate', status: 'running' }],
      decisions: [],
    }),
    false,
    'a running step is a live wait',
  );
  assert.equal(isSettledBlockedRun({ status: 'failed', steps: skipped, decisions: [] }), false);
  assert.equal(
    isSettledBlockedRun({
      status: 'blocked',
      steps: [
        { name: 'dispatch', status: 'failed', outputs: { promptDeliveryUncertain: true } },
        { name: 'monitor', status: 'skipped' },
      ],
      decisions: [],
    }),
    false,
    'an uncertain prompt delivery still owns its slot and runner',
  );
  assert.equal(
    isSettledBlockedRun({
      status: 'blocked',
      steps: [
        {
          name: 'dispatch',
          status: 'failed',
          outputs: { nativeWorkerOperationUncertain: 'delivery' },
        },
      ],
      decisions: [],
    }),
    false,
  );
  assert.equal(
    isSettledBlockedRun({
      status: 'blocked',
      steps: [
        {
          name: 'dispatch',
          status: 'done',
          outputs: { promptDeliveryUncertain: true, acknowledgement: 'task-signal' },
        },
        { name: 'monitor', status: 'done' },
      ],
      decisions: [],
    }),
    true,
    'a marker left on a step that adoption recovery completed does not hold the run',
  );
  assert.equal(
    isSettledBlockedRun({
      status: 'blocked',
      steps: undefined as never,
      decisions: undefined as never,
    }),
    true,
    'legacy persisted runs may lack the arrays',
  );
});
