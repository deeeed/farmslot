import assert from 'node:assert/strict';
import test from 'node:test';
import { URL } from 'node:url';

import type { Run, RunGetResult } from '@farmslot/protocol';
import {
  createGatewayResourceCache,
  createMemoryResourceStore,
  type ResourceQuery,
  resourceQuery,
  type ResourceQueryState,
} from '@farmslot/protocol/client-cache';

import { ResourceCacheConformanceTransport } from '../../../../../packages/protocol/src/client-cache/conformance';
import { mountHook } from '../../hooks/hook-harness.fixtures';

const scope = { gatewayUrl: 'ws://run-detail.invalid/', principalId: 'p', principalGeneration: 0 };
const authority = { roles: [], workspaceAccess: 'farm' as const };

function run(summary: string): Run {
  return {
    id: 'run-1',
    familyId: 'family-1',
    lane: 'production',
    flowType: 'fix-bug',
    status: 'done',
    project: 'example-mobile',
    ticketOrPr: 'PR-1',
    summary,
    slotId: 'slot-1',
    branch: 'fix/run-1',
    taskFile: '/repo/TASK.md',
    steps: [{ name: 'monitor', status: 'done' }],
    decisions: [],
    metrics: { nudgeCount: 0, model: null, runner: null },
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
  };
}

type Rendered = { run: Run | null; runObservation: ResourceQueryState<RunGetResult> };

function isRendered(value: unknown): value is Rendered {
  return typeof value === 'object' && value !== null && 'run' in value && 'runObservation' in value;
}

const turns = async () => {
  for (let i = 0; i < 20; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

/** The cold start Run Detail opens on: an offline gateway and a run.get saved by an earlier session. */
async function mount(listed: Run[], saved?: Run) {
  const store = createMemoryResourceStore();
  await store.setMetadata({ scope, authority });
  if (saved)
    await store.putQuery({
      id: resourceQuery<RunGetResult>('run.get', { runId: saved.id }).id,
      data: { run: saved },
      observedAt: 1,
      bytes: 1,
    });
  const transport = new ResourceCacheConformanceTransport(scope);
  transport.connection.authority = authority;
  const cache = createGatewayResourceCache({ transport, store });
  const stops: Array<() => void> = [];
  const hook = mountHook<[string]>(
    new URL('./use-run-detail-run.ts', import.meta.url),
    'useRunDetailRun',
    {
      '@farmslot/protocol/client-cache': { resourceQuery },
      '../../hooks/useResourceQuery': {
        useResourceQuery<T>(query: ResourceQuery<T> | undefined): ResourceQueryState<T> {
          if (!query) return { status: 'loading' };
          if (!stops.length) stops.push(cache.observe(query, () => {}));
          return cache.read(query);
        },
      },
      '../../store/runs': {
        useRunStore: (select: (state: { runs: Run[] }) => unknown) => select({ runs: listed }),
      },
    },
  );
  return {
    transport,
    render() {
      const result = hook.render('run-1');
      if (!isRendered(result)) throw new Error('useRunDetailRun returned no run observation');
      return result;
    },
    async dispose() {
      for (const stop of stops) stop();
      await cache.dispose();
    },
  };
}

test('a listed run renders on the first render while its saved run.get hydrates offline', async () => {
  const row = run('listed row');
  const saved = run('saved run.get');
  const detail = await mount([row], saved);
  try {
    const first = detail.render();
    // The saved run.get is read from the store asynchronously, so the first render has none.
    assert.equal(first.runObservation.status, 'loading');
    assert.equal(first.run, row);
    await turns();
    const hydrated = detail.render();
    assert.equal(hydrated.runObservation.status, 'stale');
    assert.equal(hydrated.run?.summary, 'saved run.get');
    assert.equal(detail.transport.requestCount, 0);
  } finally {
    await detail.dispose();
  }
});

test('a listed run that was never opened renders offline from its row alone', async () => {
  const row = run('listed row');
  const detail = await mount([row]);
  try {
    assert.equal(detail.render().run, row);
    await turns();
    assert.equal(detail.render().run, row);
    assert.equal(detail.transport.requestCount, 0);
  } finally {
    await detail.dispose();
  }
});

test('a run with no local copy anywhere has nothing to render', async () => {
  const detail = await mount([]);
  try {
    assert.equal(detail.render().run, null);
    await turns();
    assert.equal(detail.render().run, null);
  } finally {
    await detail.dispose();
  }
});
