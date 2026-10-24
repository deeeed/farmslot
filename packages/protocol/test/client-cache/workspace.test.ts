import assert from 'node:assert/strict';
import test from 'node:test';

import { resourceQuery } from '../../src/client-cache/registry.js';
import { workspaceRetentionEvictions } from '../../src/client-cache/workspace-retention.js';

test('opened file/directory snapshots share slot and run bounds across methods; other runs survive', () => {
  const entries = Array.from({ length: 200 }, (_, i) => {
    const query = resourceQuery(i % 2 ? 'fs.list' : 'fs.read', {
      slotId: 'a',
      runId: 'run-a',
      path: `opened/${i}`,
    });
    return { id: query.id, observedAt: i, bytes: 100 };
  });
  const other = resourceQuery('fs.read', { slotId: 'b', runId: 'run-b', path: 'keep' });
  const query = resourceQuery('fs.read', { slotId: 'a', runId: 'run-a', path: 'next' });
  const victims = workspaceRetentionEvictions(
    query,
    { id: query.id, observedAt: 201, bytes: 100 },
    [...entries, { id: other.id, observedAt: 0, bytes: 100 }],
  );
  assert.deepEqual(victims, [entries[0].id]);
  assert.ok(!victims.includes(other.id));
  assert.equal(query.persisted, true);
});
test('slot reuse cannot bypass the slot cap, and one run across slots cannot bypass its run cap', () => {
  for (const scope of ['slot', 'run']) {
    const entries = Array.from({ length: 200 }, (_, i) => ({
      id: resourceQuery('fs.read', {
        slotId: scope === 'slot' ? 'shared' : `slot-${i}`,
        runId: scope === 'run' ? 'shared' : `run-${i}`,
        path: `p${i}`,
      }).id,
      observedAt: i,
      bytes: 10,
    }));
    const query = resourceQuery('fs.list', { slotId: 'shared', runId: 'shared', path: 'new' });
    assert.deepEqual(
      workspaceRetentionEvictions(query, { id: query.id, observedAt: 999, bytes: 10 }, entries),
      [entries[0].id],
    );
  }
});
test('content bytes share a single portable-store budget across slot and native workspace queries', () => {
  const previous = resourceQuery(
    'native.session.workspace.read',
    { sessionId: 'session', path: 'large' },
    'reader',
  );
  const query = resourceQuery('fs.read', { slotId: 'slot', runId: 'run', path: 'another' });
  const budget = query.retention!.maxBytes;
  assert.deepEqual(
    workspaceRetentionEvictions(query, { id: query.id, observedAt: 2, bytes: 8 * 1024 * 1024 }, [
      { id: previous.id, observedAt: 1, bytes: budget - 1 },
    ]),
    [previous.id],
  );
});
test('workspace identities never accept client owner keys, command controls or escaping paths', () => {
  for (const extra of [
    { ownerId: 'invented' },
    { forceRefresh: true },
    { path: '../escape' },
    { cwd: '/secret' },
  ])
    assert.throws(() => resourceQuery('fs.read', { slotId: 'slot', path: 'file', ...extra }));
  const a = resourceQuery('native.session.workspace.list', { sessionId: 's', path: '.' }, 'reader');
  const b = resourceQuery(
    'native.session.workspace.list',
    { sessionId: 's', executionNodeId: 'local', path: '.' },
    'reader',
  );
  assert.equal(a.id, b.id);
});

test('reopening old saved bytes changes LRU order without claiming a newer observation', () => {
  const old = resourceQuery('fs.read', { slotId: 'same', runId: 'same', path: 'old-open-again' });
  const next = resourceQuery('fs.read', { slotId: 'same', runId: 'same', path: 'new' });
  const query = resourceQuery('fs.read', { slotId: 'same', runId: 'same', path: 'incoming' });
  const victims = workspaceRetentionEvictions(
    query,
    { id: query.id, observedAt: 30, accessedAt: 30, bytes: 10 },
    [
      { id: old.id, observedAt: 1, accessedAt: 25, bytes: 10 },
      { id: next.id, observedAt: 20, accessedAt: 20, bytes: 10 },
    ],
    20,
  );
  assert.deepEqual(victims, [next.id]);
});

test('native workspace dependencies require the real reader and retain exact worker pin', () => {
  const params = {
    sessionId: 's',
    executionNodeId: 'node-a',
    worker: { runId: 'run', contextId: 'ctx', generation: 'g', leaseId: 'lease' },
  };
  assert.throws(
    () => resourceQuery('native.session.workspace.list', params),
    /authenticated reader/,
  );
  const query = resourceQuery('native.session.workspace.list', params, 'reader-a');
  assert.deepEqual(query.dependencies, [
    {
      family: 'workspace',
      nodeId: 'node-a',
      sessionId: 's',
      ownerId: 'reader-a',
      contextId: JSON.stringify({
        contextId: 'ctx',
        generation: 'g',
        leaseId: 'lease',
        runId: 'run',
      }),
    },
  ]);
  assert.equal(Reflect.has(query.params as object, 'ownerId'), false);
});
test('an entry larger than the remaining shared content budget is memory-only', () => {
  const query = resourceQuery('fs.read', { slotId: 'slot', path: 'opened' });
  const saved = { id: query.id, observedAt: 10, accessedAt: 20, bytes: 11 };
  assert.deepEqual(workspaceRetentionEvictions(query, saved, [], 20, 10), [query.id]);
});
