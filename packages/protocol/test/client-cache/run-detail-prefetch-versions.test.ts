import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { createGatewayResourceCache } from '../../src/client-cache/cache.js';
import { canonicalResourceJson } from '../../src/client-cache/keys.js';
import { resourceQuery } from '../../src/client-cache/registry.js';
import { createMemoryResourceStore, type ResourceStore } from '../../src/client-cache/store.js';
import type {
  ResourceCacheConnection,
  ResourceCacheTransport,
} from '../../src/client-cache/types.js';
import type { Run } from '../../src/contracts/runs.js';
import { Methods } from '../../src/rpc/registry.js';
import type { RunGetResult, RunListResult } from '../../src/rpc/run.js';
import { runListRow, trimRunForList } from '../../src/runs/list-trim.js';

const scope = {
  gatewayUrl: 'ws://prefetch-versions.invalid/',
  principalId: 'p',
  principalGeneration: 0,
};
const authority = { roles: [], workspaceAccess: 'farm' as const };

/** The gateway's row version: sha256 of trimRunForList(run), as runGet's listVersion. */
const version = (run: Run) =>
  createHash('sha256')
    .update(canonicalResourceJson(trimRunForList(run)))
    .digest('hex');

function run(id: string, summary = 'stored'): Run {
  return {
    id,
    familyId: `family-${id}`,
    lane: 'production',
    flowType: 'dev',
    status: 'monitoring',
    project: 'demo',
    ticketOrPr: `T-${id}`,
    summary,
    slotId: null,
    branch: null,
    taskFile: null,
    steps: [{ name: 'work', status: 'running', outputs: { transcript: 'worker transcript' } }],
    decisions: [],
    metrics: { nudgeCount: 0, model: null, runner: null },
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
  };
}

const flush = async () => {
  for (let turn = 0; turn < 60; turn++) await new Promise((resolve) => setImmediate(resolve));
};

/**
 * A gateway serving `live`, with run.get details for those runs already stored on the client
 * (each saved with the gateway's listVersion). `slim` picks the row shape: runListRow (current
 * gateway) or trimRunForList (older gateway). Counts run.get reads.
 */
async function world({
  live,
  stored,
  slim,
  versionLists,
}: {
  live: Run[];
  stored: Run[];
  slim: boolean;
  versionLists: boolean;
}) {
  const saved = createMemoryResourceStore();
  const store: ResourceStore = { ...saved, persistent: true, async close() {} };
  await store.setMetadata({ scope, authority });
  for (const held of stored)
    await store.putQuery({
      id: resourceQuery<RunGetResult>(Methods.RUN_GET, { runId: held.id }).id,
      data: { run: held, listVersion: version(held) },
      observedAt: 1,
      bytes: 1,
    });
  const byId = new Map(live.map((value) => [value.id, value]));
  const row = (value: Run) => (slim ? runListRow(value) : trimRunForList(value));
  const runGets: string[] = [];
  const connection: ResourceCacheConnection = {
    id: 1,
    connected: true,
    metered: false,
    authMode: 'token',
    scope,
    authority,
    capabilities: {
      httpBearerAuth: true,
      voiceInstructionFormatting: false,
      resourceChanges: { version: 1, epoch: 'epoch', versionLists },
    },
  };
  const transport: ResourceCacheTransport = {
    getConnection: () => connection,
    onConnectionChange: () => () => {},
    onResourceChanged: () => () => {},
    resynchronize: () => {},
    async request<T>(method: string, params: unknown) {
      const stamp = (dependencies: ReturnType<typeof resourceQuery>['dependencies']) => ({
        epoch: 'epoch',
        dependencies: dependencies.map((key) => ({ key, revision: 1 })),
      });
      const field = (name: string): unknown =>
        params && typeof params === 'object' ? Reflect.get(params, name) : undefined;
      if (method === Methods.RUN_GET) {
        const runId = field('runId');
        assert.equal(typeof runId, 'string');
        runGets.push(String(runId));
        const value = byId.get(String(runId))!;
        const result: RunGetResult = { run: value, listVersion: version(value) };
        const query = resourceQuery(Methods.RUN_GET, { runId: value.id });
        return { data: result as T, resourceState: stamp(query.dependencies) };
      }
      assert.equal(method, Methods.RUN_LIST);
      const versions = live.map((value) => ({ id: value.id, version: version(value) }));
      const ids = field('ids');
      const result: RunListResult =
        field('versions') === true
          ? { runs: [], totalCount: live.length, versions }
          : Array.isArray(ids)
            ? {
                runs: live.filter((value) => ids.includes(value.id)).map(row),
                totalCount: ids.length,
                versions: versions.filter(({ id }) => ids.includes(id)),
              }
            : { runs: live.map(row), totalCount: live.length };
      const query = resourceQuery(Methods.RUN_LIST, {});
      return { data: result as T, resourceState: stamp(query.dependencies) };
    },
  };
  const cache = createGatewayResourceCache({ transport, store });
  const stop = cache.observe(resourceQuery(Methods.RUN_LIST, {}), () => {});
  await flush();
  return {
    runGets,
    async dispose() {
      stop();
      await cache.dispose();
    },
  };
}

test('slim rows with no version list held cause no run.get prefetch', async () => {
  const runs = [run('a'), run('b'), run('c')];
  const current = await world({ live: runs, stored: runs, slim: true, versionLists: false });
  try {
    assert.deepEqual(current.runGets, []);
  } finally {
    await current.dispose();
  }
});

test('once versions are held, only runs whose version changed are read again', async () => {
  const stored = [run('a'), run('b'), run('c')];
  const live = [run('a'), run('b', 'changed after it was stored'), run('c')];
  const current = await world({ live, stored, slim: true, versionLists: true });
  try {
    assert.deepEqual(current.runGets, ['b']);
  } finally {
    await current.dispose();
  }
});

test('an older gateway with full rows rereads changed runs only, as before slim rows', async () => {
  const stored = [run('a'), run('b')];
  const live = [run('a'), run('b', 'changed after it was stored')];
  const older = await world({ live, stored, slim: false, versionLists: false });
  try {
    assert.deepEqual(older.runGets, ['b']);
  } finally {
    await older.dispose();
  }
});
