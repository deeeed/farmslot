import assert from 'node:assert/strict';
import test from 'node:test';

import type { ResourceChangedPayload } from '@farmslot/protocol';

import { GatewayResourceRevisions } from './revisions.js';
import { captureRunResources, publishRunResources } from './run-changes.js';

test('legacy records without family or decisions retain their own resource identity', () => {
  assert.deepEqual(captureRunResources({ id: 'legacy' }), {
    id: 'legacy',
    familyId: 'legacy',
    decisionIds: [],
  });
});

test('a run moving families invalidates both memberships and removed decision projections', async () => {
  const revisions = new GatewayResourceRevisions();
  const packets: ResourceChangedPayload[] = [];
  revisions.setPublisher((packet) => packets.push(packet));
  const record = { id: 'run', familyId: 'before', decisions: [{ id: 'resolved' }] };
  const previous = captureRunResources(record);
  record.familyId = 'after';
  record.decisions.splice(0, 1, { id: 'new-gate' });
  try {
    publishRunResources(captureRunResources(record), previous, 'updated', revisions);
    await Promise.resolve();
    assert.deepEqual(previous, { id: 'run', familyId: 'before', decisionIds: ['resolved'] });
    assert.equal(revisions.revision({ family: 'family', familyId: 'before' }), 1);
    assert.equal(revisions.revision({ family: 'family', familyId: 'after' }), 1);
    const changes = packets.flatMap((packet) => packet.changes);
    assert(changes.some(({ key }) => key.family === 'runs' && key.scope === 'farm'));
    assert(changes.some(({ key }) => key.family === 'decisions'));
    for (const family of ['decision', 'gate', 'package']) {
      assert(
        changes.some(
          ({ key, kind }) =>
            key.family === family &&
            'decisionId' in key &&
            key.decisionId === 'resolved' &&
            kind === 'deleted',
        ),
      );
      assert(
        changes.some(
          ({ key, kind }) =>
            key.family === family &&
            'decisionId' in key &&
            key.decisionId === 'new-gate' &&
            kind === 'updated',
        ),
      );
    }
  } finally {
    revisions.dispose();
  }
});

test('deleting a run invalidates its retained views and collection membership', async () => {
  const revisions = new GatewayResourceRevisions();
  const packets: ResourceChangedPayload[] = [];
  revisions.setPublisher((packet) => packets.push(packet));
  try {
    const run = captureRunResources({ id: 'deleted', decisions: [{ id: 'decision' }] });
    publishRunResources(run, undefined, 'deleted', revisions);
    await Promise.resolve();
    const changes = packets.flatMap((packet) => packet.changes);
    assert.equal(run.familyId, 'deleted');
    for (const family of ['run', 'gate', 'package', 'review', 'artifacts'])
      assert(
        changes.some(
          ({ key, kind }) =>
            key.family === family &&
            'runId' in key &&
            key.runId === 'deleted' &&
            kind === 'deleted',
        ),
      );
    assert(changes.some(({ key, kind }) => key.family === 'runs' && kind === 'updated'));
    assert(changes.some(({ key, kind }) => key.family === 'family' && kind === 'updated'));
    assert(changes.some(({ key, kind }) => key.family === 'decision' && kind === 'deleted'));
  } finally {
    revisions.dispose();
  }
});

test('a shared family is advanced once while separate run writes still advance revisions', async () => {
  const revisions = new GatewayResourceRevisions();
  try {
    const run = captureRunResources({ id: 'run', familyId: 'family', decisions: [] });
    publishRunResources(run, run, 'updated', revisions);
    assert.equal(revisions.revision({ family: 'family', familyId: 'family' }), 1);
    publishRunResources(run, run, 'updated', revisions);
    assert.equal(revisions.revision({ family: 'family', familyId: 'family' }), 2);
    assert.equal(revisions.revision({ family: 'run', runId: 'run' }), 2);
  } finally {
    revisions.dispose();
  }
});

test('a completed decision expires from the inbox once without pretending the run changed', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 200_000_000 });
  const revisions = new GatewayResourceRevisions();
  const run = {
    id: 'expiring',
    status: 'done' as const,
    completedAt: new Date(Date.now() - 48 * 60 * 60 * 1000 + 20).toISOString(),
    decisions: [{ id: 'pending' }],
  };
  const key = { family: 'decisions', scope: 'farm' } as const;
  try {
    publishRunResources(captureRunResources(run), undefined, 'updated', revisions);
    t.mock.timers.tick(19);
    assert.equal(revisions.revision(key), 1);
    t.mock.timers.tick(1);
    assert.equal(revisions.revision(key), 2);
    assert.equal(revisions.revision({ family: 'run', runId: run.id }), 1);
    t.mock.timers.tick(100);
    assert.equal(revisions.revision(key), 2);
  } finally {
    revisions.dispose();
  }
});

for (const change of ['resolved', 'reactivated', 'archived', 'deleted'] as const) {
  test(`a ${change} run cannot publish an obsolete inbox expiry`, (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 200_000_000 });
    const revisions = new GatewayResourceRevisions();
    const run = {
      id: change,
      status: 'done' as const,
      completedAt: new Date(Date.now() - 48 * 60 * 60 * 1000 + 20).toISOString(),
      decisions: [{ id: 'pending' }],
    };
    const key = { family: 'decisions', scope: 'farm' } as const;
    try {
      publishRunResources(captureRunResources(run), undefined, 'updated', revisions);
      const current =
        change === 'resolved'
          ? { ...run, decisions: [{ id: 'pending', resolvedAt: new Date().toISOString() }] }
          : change === 'reactivated'
            ? { ...run, status: 'monitoring' as const }
            : change === 'archived'
              ? { ...run, archivedAt: new Date().toISOString() }
              : run;
      publishRunResources(
        captureRunResources(current),
        undefined,
        change === 'deleted' ? 'deleted' : 'updated',
        revisions,
      );
      t.mock.timers.tick(21);
      assert.equal(revisions.revision(key), 2);
    } finally {
      revisions.dispose();
    }
  });
}

test('separate runs keep separate inbox deadlines and disposal cancels remaining deadlines', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 200_000_000 });
  const revisions = new GatewayResourceRevisions();
  const key = { family: 'decisions', scope: 'farm' } as const;
  for (const delay of [20, 40]) {
    const run = {
      id: String(delay),
      status: 'done' as const,
      completedAt: new Date(Date.now() - 48 * 60 * 60 * 1000 + delay).toISOString(),
      decisions: [{ id: 'pending' }],
    };
    publishRunResources(captureRunResources(run), undefined, 'updated', revisions);
  }
  t.mock.timers.tick(20);
  assert.equal(revisions.revision(key), 3);
  revisions.dispose();
  t.mock.timers.tick(40);
  assert.equal(revisions.revision(key), 3);
});
