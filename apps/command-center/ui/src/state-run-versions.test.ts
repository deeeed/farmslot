import assert from 'node:assert/strict';
import test from 'node:test';

import { Methods, type Run, type RunListParams, type RunListResult } from '@farmslot/protocol';
import { resourceQuery } from '@farmslot/protocol/client-cache';

import { installFakeGateway } from './testing/fake-gateway.js';

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run-1',
    familyId: 'family-1',
    parentRunId: null,
    lane: 'production',
    flowType: 'fix-bug',
    status: 'monitoring',
    project: 'farm',
    ticketOrPr: 'owner/repo#1',
    slotId: null,
    branch: null,
    taskFile: null,
    steps: [],
    decisions: [],
    metrics: { nudgeCount: 0, model: 'gpt-5.5', runner: 'codex' },
    createdAt: '2026-10-20T00:00:00.000Z',
    updatedAt: '2026-10-20T00:00:00.000Z',
    ...overrides,
  } as Run;
}

/** Filters a gateway applies to `run.list`; a version-list client answers them locally. */
const FILTERS = ['active', 'tags', 'familyId', 'project', 'search'] as const;

async function connectWithRuns(t: import('node:test').TestContext) {
  const fakeGateway = installFakeGateway(t, 'operator-a');
  fakeGateway.resourceEpoch = 'run-versions-epoch';
  fakeGateway.versionLists = true;
  const runs = [
    makeRun({ id: 'run-1', tags: ['nightly'] }),
    makeRun({
      id: 'run-2',
      status: 'done',
      familyId: 'family-2',
      createdAt: '2026-10-19T00:00:00.000Z',
    }),
  ];
  const runsState = {
    epoch: fakeGateway.resourceEpoch,
    dependencies: [{ key: { family: 'runs', scope: 'farm' }, revision: 0 }],
  };
  const version = (run: Run) => ({ id: run.id, version: `${run.id}@1` });
  fakeGateway.responseForRequest = ({ method, params }) => {
    if (method === 'run.list') {
      const list = (params ?? {}) as RunListParams;
      if (list.versions)
        return {
          payload: { runs: [], totalCount: runs.length, versions: runs.map(version) },
          resourceState: runsState,
        };
      const served = list.ids ? runs.filter(({ id }) => list.ids?.includes(id)) : runs;
      return {
        payload: { runs: served, totalCount: runs.length, versions: served.map(version) },
        resourceState: runsState,
      };
    }
    if (method === 'decision.list') return { payload: { decisions: [] } };
    if (method === 'fleet.status')
      return { payload: { fleet: { checkedAt: '2026-10-20T00:00:00Z', slots: [], summary: {} } } };
    if (method === 'pr.list') return { payload: { prs: [] } };
    if (method === 'config.projects') return { payload: { projects: [] } };
    if (method === 'workGraph.list') return { payload: { graphs: [] } };
    return { payload: { items: [] } };
  };

  const { gateway } = await import('./gateway-client.js');
  const { getState, initState, runHistoryQuery, activeRunsQuery } = await import('./state.js');
  const { getResourceCache, disposeResourceCache } = await import('./resource-cache.js');
  fakeGateway.beforeRestore = async () => {
    gateway.disconnect();
    await disposeResourceCache();
  };
  const flush = async () => {
    for (let i = 0; i < 20; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
  };
  initState();
  await gateway.setAuthCredentials({ token: 'operator-a-secret' });
  gateway.connect();
  await flush();
  assert.equal(gateway.connectionState, 'connected');
  const cache = getResourceCache()!;
  await Promise.all([cache.retry(runHistoryQuery), cache.retry(activeRunsQuery)]);
  const tagged = await cache.retry(
    resourceQuery<RunListResult>(Methods.RUN_LIST, { tags: ['nightly'] }),
  );
  const family = await cache.retry(
    resourceQuery<RunListResult>(Methods.RUN_LIST, { familyId: 'family-2' }),
  );
  await flush();
  const sent = fakeGateway.requests
    .filter(({ method }) => method === Methods.RUN_LIST)
    .map(({ params }) => (params ?? {}) as Record<string, unknown>);
  return { getState, tagged, family, sent };
}

test('with version lists, the run collection and its filtered views read no filtered run.list', async (t) => {
  const { getState, tagged, family, sent } = await connectWithRuns(t);
  assert.deepEqual(
    getState().runs.map(({ id }) => id),
    ['run-1', 'run-2'],
  );
  assert.equal(getState().runsObservation.data?.totalCount, 2);
  assert.deepEqual(
    tagged.data?.runs.map(({ id }) => id),
    ['run-1'],
  );
  assert.equal(tagged.data?.totalCount, 1, 'a filtered total counts matching projections');
  assert.deepEqual(
    family.data?.runs.map(({ id }) => id),
    ['run-2'],
  );
  assert.ok(
    sent.some((params) => params.versions === true),
    'the collection reads its versions',
  );
  for (const params of sent)
    for (const filter of FILTERS)
      assert.equal(params[filter], undefined, `no run.list on the wire carries ${filter}`);
});
