import assert from 'node:assert/strict';
import test from 'node:test';

import { resourceQuery } from '../../src/client-cache/registry.js';
import { createRunDetailSync, runDetailTarget } from '../../src/client-cache/run-details.js';
import type { StoredResourceQuery } from '../../src/client-cache/store.js';
import type { ResourceCacheConnection } from '../../src/client-cache/types.js';
import type { Run } from '../../src/contracts/runs.js';
import type { RunGetResult } from '../../src/rpc/run.js';
import { runListVersion } from '../../src/runs/list-version.js';
import { storedRun } from '../fixtures/run.js';

const encoder = new TextEncoder();
const bytes = (run: Run) => encoder.encode(JSON.stringify({ run })).byteLength;
async function until(condition: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!condition()) {
    assert(Date.now() < deadline, 'detail sync did not settle');
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function fixture(runs: Run[], budgetBytes?: number, presented = false) {
  const values = new Map(runs.map((run) => [run.id, run]));
  const rows = new Map<string, StoredResourceQuery<RunGetResult>>();
  const fetched: string[] = [];
  const touched: string[] = [];
  const errors: unknown[] = [];
  const connection: ResourceCacheConnection = {
    id: 1,
    connected: true,
    metered: false,
    authMode: 'none',
    scope: { gatewayUrl: 'ws://localhost:1234' },
  };
  const key = (id: string) => resourceQuery('run.get', { runId: id }).id;
  const sync = createRunDetailSync({
    budgetBytes,
    connection: () => connection,
    list: async () => [...rows.values()],
    stored: async (id) => rows.get(key(id)),
    touch: async (id) => {
      touched.push(id);
    },
    fetch: async (id, maxBytes, signal) => {
      assert.equal(signal.aborted, false);
      fetched.push(id);
      const run = values.get(id);
      assert(run);
      const data = presented
        ? { run: { ...run, liveRecipeContext: null }, listVersion: runListVersion(run) }
        : { run };
      const observedAt = Date.now();
      if (bytes(run) <= maxBytes)
        rows.set(key(id), { id: key(id), data, bytes: bytes(run), observedAt });
      return { status: 'ready', data, observedAt };
    },
    onError: (error) => errors.push(error),
  });
  const targets = () =>
    [...values.values()].map((run) => runDetailTarget(run, runListVersion(run)));
  return { values, rows, fetched, touched, errors, connection, sync, targets };
}

test('all listed details sync by priority and unchanged versions do not reread', async () => {
  const history = storedRun('history');
  const active = storedRun('active', { status: 'monitoring' });
  const gate = storedRun('gate', {
    status: 'human-gating',
    decisions: [
      {
        id: 'gate-1',
        type: 'engine_human_gate',
        title: 'Review',
        description: '',
        createdAt: history.createdAt,
        actions: [],
      },
    ],
  });
  const world = fixture([history, active, gate]);
  try {
    world.sync.setTargets(world.targets());
    await until(() => world.rows.size === 3);
    assert.deepEqual(world.fetched, ['gate', 'active', 'history']);
    world.sync.setTargets(world.targets());
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(world.fetched.length, 3);
    world.values.set('history', { ...history, summary: 'New version' });
    world.sync.setTargets(world.targets());
    await until(() => world.fetched.length === 4);
    assert.deepEqual(world.fetched, ['gate', 'active', 'history', 'history']);
    assert.deepEqual(world.errors, []);
  } finally {
    world.sync.reset();
  }
});

test('a byte-bound batch does not persist a history reply beyond its remaining budget', async () => {
  const active = storedRun('active', { status: 'monitoring' });
  const history = storedRun('history');
  const world = fixture([active, history], bytes(active) + bytes(history) - 1);
  try {
    world.sync.setTargets(world.targets());
    await until(() => world.fetched.length === 2);
    assert.equal(world.rows.size, 1);
    assert.equal([...world.rows.values()][0].data.run.id, 'active');
    assert.deepEqual(world.errors, []);
  } finally {
    world.sync.reset();
  }
});

test('a new sync instance reuses stored details whose served version is unchanged', async () => {
  const run = storedRun('saved');
  const first = fixture([run]);
  first.sync.setTargets(first.targets());
  await until(() => first.rows.size === 1);
  first.sync.reset();
  const reopened = fixture([run]);
  for (const [id, row] of first.rows) reopened.rows.set(id, row);
  try {
    reopened.sync.setTargets(reopened.targets());
    await until(() => reopened.touched.length === 1);
    assert.deepEqual(reopened.fetched, []);
  } finally {
    reopened.sync.reset();
  }
});

for (const metered of [true, undefined]) {
  test(`${metered === true ? 'metered' : 'unknown-cost'} sync reads active details and leaves history rows`, async () => {
    const world = fixture([storedRun('history'), storedRun('active', { status: 'monitoring' })]);
    world.connection.metered = metered;
    try {
      world.sync.setTargets(world.targets());
      await until(() => world.rows.size === 1);
      assert.deepEqual(world.fetched, ['active']);
      world.connection.foreground = false;
      world.sync.setTargets(world.targets());
      assert.deepEqual(world.fetched, ['active']);
    } finally {
      world.sync.reset();
    }
  });
}

test('presentation-only fields do not refetch unchanged detail after restart', async () => {
  const first = storedRun('bundled', { status: 'monitoring' });
  const second = storedRun('other', { status: 'monitoring' });
  const world = fixture([first, second], undefined, true);
  try {
    world.sync.setTargets(world.targets());
    await until(() => world.rows.size === 2);
    world.values.set('other', { ...second, summary: 'Changed list row' });
    world.sync.setTargets(world.targets());
    await until(() => world.fetched.length >= 3);
    assert.deepEqual(world.fetched, ['bundled', 'other', 'other']);
    world.sync.reset();
    world.sync.setTargets(world.targets());
    await until(() => world.touched.length >= 3);
    assert.equal(world.fetched.length, 3);
  } finally {
    world.sync.reset();
  }
});
