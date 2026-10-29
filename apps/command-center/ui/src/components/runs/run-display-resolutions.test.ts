import assert from 'node:assert/strict';
import test from 'node:test';

import type { RunDecision } from '@farmslot/protocol';

import { RunDisplayResolutions } from './run-display-resolutions.js';

const pending: RunDecision = {
  id: 'gate-a',
  type: 'engine_human_gate',
  title: 'Gate',
  description: '',
  createdAt: '2026-10-29T00:00:00Z',
  actions: [],
  payload: {
    kind: 'ready',
    prNumber: null,
    repo: null,
    branch: '',
    workerReport: '',
    reviews: [],
    diffStat: { files: 0, additions: 0, deletions: 0 },
  },
};

test('refetch metadata gaps cannot reopen the displayed gate, mutate the read, or restore missing decisions', () => {
  const display = new RunDisplayResolutions();
  const resolved = {
    ...pending,
    resolvedAt: '2026-10-30T00:00:00Z',
    resolvedAction: 'approve-publish',
  };
  const scope = 'owner-a/run-a';
  display.read(scope, [resolved]);
  const [retained] = display.read(scope, [pending]);
  assert.equal(retained.resolvedAt, resolved.resolvedAt);
  assert.equal(retained.resolvedAction, 'approve-publish');
  assert.equal(pending.resolvedAt, undefined, 'The canonical read stays unchanged');
  assert.deepEqual(display.read(scope, []), [], 'Removed decisions stay removed');
  assert.equal(display.read(scope, [{ ...pending, id: 'gate-b' }])[0].resolvedAt, undefined);
});

test('run, principal and gateway changes clear prior resolution metadata', () => {
  for (const next of ['owner-a/run-b', 'owner-b/run-a', 'gateway-b/owner-a/run-a', undefined]) {
    const display = new RunDisplayResolutions();
    display.read('owner-a/run-a', [{ ...pending, resolvedAt: '2026-10-30T00:00:00Z' }]);
    assert.equal(display.read(next, [pending])[0].resolvedAt, undefined);
    assert.equal(display.read('owner-a/run-a', [pending])[0].resolvedAt, undefined);
  }
});

test('provisional replay supersession can reopen and never becomes a retained resolution', () => {
  const display = new RunDisplayResolutions();
  const superseded = {
    ...pending,
    resolvedAt: '2026-10-30T00:00:00Z',
    resolvedAction: 'superseded',
  };
  assert.equal(display.read('owner/run', [superseded])[0], superseded);
  assert.equal(display.read('owner/run', [pending])[0].resolvedAt, undefined);
});
