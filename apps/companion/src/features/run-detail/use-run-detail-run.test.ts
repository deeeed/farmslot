import assert from 'node:assert/strict';
import test from 'node:test';
import { URL } from 'node:url';

import type { Run, RunGetResult } from '@farmslot/protocol';
import {
  canActOn,
  createGatewayResourceCache,
  createMemoryResourceStore,
  readRefused,
  type ResourceQuery,
  resourceQuery,
  type ResourceQueryState,
  type ResourceReadMethod,
} from '@farmslot/protocol/client-cache';

import { ResourceCacheConformanceTransport } from '../../../../../packages/protocol/src/client-cache/conformance';
import { mountHook } from '../../hooks/hook-harness.fixtures';

const scope = { gatewayUrl: 'ws://run-detail.invalid/', principalId: 'p', principalGeneration: 0 };
const authority = { roles: [], workspaceAccess: 'farm' as const };

function run(summary: string, updatedAt = '2026-11-01T00:00:00.000Z'): Run {
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
    updatedAt,
  };
}

type Rendered = {
  run: Run | null;
  fromList: boolean;
  runActionable: boolean;
  runObservation: ResourceQueryState<RunGetResult>;
};

function isRendered(value: unknown): value is Rendered {
  return (
    typeof value === 'object' &&
    value !== null &&
    'run' in value &&
    'fromList' in value &&
    'runObservation' in value
  );
}

const turns = async () => {
  for (let i = 0; i < 20; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

/**
 * The cold start Run Detail opens on: a run.get saved by an earlier session, and a gateway
 * that is offline unless `online`, in which case the test answers the read itself.
 */
async function mount(listed: Run[], saved?: Run, online = false, answer?: Run) {
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
  if (online) transport.setConnection({ connected: true, id: 1 });
  // A gateway that answers run.get with `answer` at once.
  if (answer)
    transport.request = async <T>(method: ResourceReadMethod, params: unknown) => {
      transport.requestCount++;
      const result: RunGetResult = { run: answer };
      const dependencies = resourceQuery(method, params).dependencies.map((key) => ({
        key,
        revision: 1,
      }));
      return { data: result as T, resourceState: { epoch: 'conformance-epoch', dependencies } };
    };
  const cache = createGatewayResourceCache({ transport, store });
  const stops: Array<() => void> = [];
  const hook = mountHook<[string]>(
    new URL('./use-run-detail-run.ts', import.meta.url),
    'useRunDetailRun',
    {
      '@farmslot/protocol/client-cache': { canActOn, readRefused, resourceQuery },
      '../../store/held-connection': { useHeldConnection: () => online },
      '../../hooks/useResourceQuery': {
        useResourceQuery<T>(query: ResourceQuery<T> | undefined): ResourceQueryState<T> {
          if (!query) return { status: 'loading' };
          if (!stops.length) stops.push(cache.observe(query, () => {}));
          return cache.read(query);
        },
      },
      '../../store/runs': {
        useRunStore: (
          select: (state: { runs: Run[]; observation: ResourceQueryState }) => unknown,
        ) => select({ runs: listed, observation: { status: 'stale' } }),
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

test('a refused run.get drops the row; a failed one keeps it', async () => {
  for (const [code, kept] of [
    ['RUN_NOT_FOUND', false],
    ['READ_FAILED', true],
  ] as const) {
    const row = run('listed row');
    const detail = await mount([row], undefined, true);
    try {
      assert.equal(detail.render().run, row);
      const read = await detail.transport.nextRead();
      read.reject(code);
      await turns();
      const after = detail.render();
      assert.equal(after.runObservation.error?.code, code);
      assert.equal(after.run, kept ? row : null, code);
    } finally {
      await detail.dispose();
    }
  }
});

test('the newer of the row and the saved run.get is the one shown', async () => {
  const older = '2026-11-01T00:00:00.000Z';
  const newer = '2026-11-01T00:05:00.000Z';
  for (const [rowAt, savedAt, shown] of [
    [newer, older, 'listed row'],
    [older, newer, 'saved run.get'],
  ] as const) {
    const detail = await mount([run('listed row', rowAt)], run('saved run.get', savedAt));
    try {
      detail.render();
      await turns();
      const hydrated = detail.render();
      assert.equal(hydrated.runObservation.status, 'stale');
      assert.equal(hydrated.run?.summary, shown);
      assert.equal(hydrated.fromList, shown === 'listed row');
    } finally {
      await detail.dispose();
    }
  }
});

test('online, a current run.get stays on screen when a newer row arrives', async () => {
  const listed = [run('listed row', '2026-11-01T00:00:00.000Z')];
  const detail = await mount(listed, undefined, true, run('run.get', '2026-11-01T00:01:00.000Z'));
  try {
    assert.equal(detail.render().fromList, true);
    await turns();
    // Read over a live connection: current, so it can be acted on.
    assert.equal(detail.render().runActionable, true);
    // A run write lands in run.list before run.get's reread does.
    listed[0] = run('newer listed row', '2026-11-01T00:02:00.000Z');
    const after = detail.render();
    assert.equal(after.run?.summary, 'run.get');
    assert.equal(after.fromList, false);
  } finally {
    await detail.dispose();
  }
});
