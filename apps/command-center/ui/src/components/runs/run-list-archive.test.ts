import assert from 'node:assert/strict';
import test from 'node:test';

import type { Run, RunListResult } from '@farmslot/protocol';
import { createGatewayResourceCache, resourceQuery } from '@farmslot/protocol/client-cache';

import { ResourceCacheConformanceTransport } from '../../../../../../packages/protocol/src/client-cache/conformance.js';

import { archiveRunSelection } from './run-list-archive.js';

function row(id: string): Run {
  return {
    id,
    familyId: id,
    parentRunId: null,
    familyRootTicketOrPr: id,
    lane: 'production',
    variant: null,
    flowType: 'dev',
    mode: 'interactive',
    project: 'farm',
    ticketOrPr: id,
    status: 'done',
    slotId: null,
    taskFile: null,
    branch: null,
    steps: [],
    decisions: [],
    metrics: { runner: null, model: null, nudgeCount: 0 },
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

for (const scenario of [
  'invalidation',
  'raced-invalidation',
  'connection-change',
  'refusal',
  'already-current',
] as const) {
  test(`archive selection: ${scenario}`, async () => {
    const transport = new ResourceCacheConformanceTransport({
      gatewayUrl: 'ws://archive.invalid/',
      principalId: 'owner',
      principalGeneration: 0,
    });
    transport.setConnection({ connected: true, id: 1 });
    const cache = createGatewayResourceCache({ transport });
    // This transport fixture stamps Sources; the batch only consumes portable query state.
    const query = resourceQuery<RunListResult>('sources.status');
    const stop = cache.observe(query, () => {});
    const writes: string[] = [];
    let current = true;
    try {
      const ready = cache.retry(query);
      const initial = { value: 'initial', runs: [row('first'), row('second')], totalCount: 2 };
      (await transport.nextRead()).resolve(initial);
      await ready;
      const done = archiveRunSelection(['first', 'second'], {
        cache,
        queries: [query],
        isCurrent: () => current,
        archive: async (id) => {
          writes.push(id);
          if (id === 'first') {
            if (scenario === 'refusal') throw new Error('Archive refused');
            if (
              scenario === 'invalidation' ||
              scenario === 'raced-invalidation' ||
              scenario === 'connection-change'
            )
              transport.advance(1);
          }
        },
      });
      if (
        scenario === 'invalidation' ||
        scenario === 'raced-invalidation' ||
        scenario === 'connection-change'
      ) {
        const pending = await transport.nextRead();
        assert.deepEqual(writes, ['first'], 'The next command waits for current query facts');
        if (scenario === 'connection-change') current = false;
        const remaining = { value: 'remaining', runs: [row('second')], totalCount: 1 };
        if (scenario === 'raced-invalidation') transport.advance(2);
        pending.resolve(remaining, 1);
        if (scenario === 'raced-invalidation') {
          const catchup = await transport.nextRead();
          assert.deepEqual(writes, ['first'], 'A raced reply is not current command authority');
          catchup.resolve(remaining, 2);
        }
      }
      const failures = await done;
      assert.deepEqual(writes, scenario === 'connection-change' ? ['first'] : ['first', 'second']);
      if (scenario === 'refusal') assert.equal(failures.get('first'), 'Archive refused');
      else if (scenario === 'connection-change')
        assert.match(failures.get('second') ?? '', /connection changed/);
      else assert.equal(failures.size, 0);
      assert.equal(
        transport.requestCount,
        scenario === 'raced-invalidation'
          ? 3
          : scenario === 'invalidation' || scenario === 'connection-change'
            ? 2
            : 1,
        'Only invalidated queries are reread; a refused command is not replayed',
      );
    } finally {
      stop();
      await cache.dispose();
    }
  });
}

test('archive selection reads a paced list at once before the next archive', async () => {
  const transport = new ResourceCacheConformanceTransport({
    gatewayUrl: 'ws://archive.invalid/',
    principalId: 'owner',
    principalGeneration: 0,
  });
  transport.setConnection({ connected: true, id: 1 });
  const cache = createGatewayResourceCache({ transport });
  // Paced like the run lists: a change within 30 s of the last read waits for the floor.
  const query = {
    ...resourceQuery<RunListResult>('sources.status'),
    rereadIntervalMs: { sources: 30_000 },
  };
  const stop = cache.observe(query, () => {});
  const writes: string[] = [];
  try {
    const ready = cache.retry(query);
    const initial = { value: 'initial', runs: [row('first'), row('second')], totalCount: 2 };
    (await transport.nextRead()).resolve(initial);
    await ready;
    const done = archiveRunSelection(['first', 'second'], {
      cache,
      queries: [query],
      isCurrent: () => true,
      archive: async (id) => {
        writes.push(id);
        if (id === 'first') transport.advance(1);
      },
    });
    for (let turn = 0; turn < 20; turn++) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(transport.requestCount, 2, 'The next archive does not wait out the floor');
    assert.deepEqual(writes, ['first']);
    const remaining = { value: 'remaining', runs: [row('second')], totalCount: 1 };
    (await transport.nextRead()).resolve(remaining, 1);
    assert.equal((await done).size, 0);
    assert.deepEqual(writes, ['first', 'second']);
  } finally {
    stop();
    await cache.dispose();
  }
});
