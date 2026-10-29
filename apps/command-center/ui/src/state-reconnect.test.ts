import assert from 'node:assert/strict';
import test from 'node:test';

import type { FleetStatus, Run } from '@farmslot/protocol';
import { RESOURCE_REREAD_INTERVAL_MS } from '@farmslot/protocol/client-cache';

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

test('the workspace survives a gateway restart and clears only for another account', async (t) => {
  const fakeGateway = installFakeGateway(t, 'operator-a');
  fakeGateway.resourceEpoch = 'run-state-epoch';
  let serverRuns = [makeRun()];
  let runRevision = 0;
  let answerRuns = true;
  let fleetRevision = 0;
  let answerFleet = true;
  let serverFleet = {
    checkedAt: '2026-10-20T00:00:00Z',
    slots: [{ slot: 'fleet-slot', lifecycle: 'ready' }],
    summary: {},
  } as FleetStatus;
  fakeGateway.responseForRequest = ({ method }) => {
    if (method === 'run.list')
      return answerRuns
        ? {
            payload: { runs: serverRuns, totalCount: serverRuns.length },
            resourceState: {
              epoch: fakeGateway.resourceEpoch,
              dependencies: [{ key: { family: 'runs', scope: 'farm' }, revision: runRevision }],
            },
          }
        : undefined;
    if (method === 'decision.list')
      return {
        payload: { decisions: [] },
        resourceState: {
          epoch: fakeGateway.resourceEpoch,
          dependencies: [{ key: { family: 'decisions', scope: 'farm' }, revision: 0 }],
        },
      };
    if (method === 'fleet.status')
      return answerFleet
        ? {
            payload: { fleet: serverFleet },
            resourceState: {
              epoch: fakeGateway.resourceEpoch,
              dependencies: [{ key: { family: 'slots', scope: 'farm' }, revision: fleetRevision }],
            },
          }
        : undefined;
    if (method === 'pr.list') return { payload: { prs: [] } };
    if (method === 'config.projects') return { payload: { projects: [] } };
    if (method === 'workGraph.list') return { payload: { graphs: [] } };
    return { payload: { items: [] } };
  };

  const { gateway } = await import('./gateway-client.js');
  const {
    getState,
    initState,
    isHydrating,
    onWorkspaceOwnerChange,
    runHistoryQuery,
    activeRunsQuery,
    fleetQuery,
    isFleetCurrent,
  } = await import('./state.js');
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
  await Promise.all([
    getResourceCache()!.retry(runHistoryQuery),
    getResourceCache()!.retry(activeRunsQuery),
  ]);
  assert.equal(getState().runs.length, 1);
  assert.equal(getState().fleetObservation.status, 'ready');
  assert.equal(isFleetCurrent(), true);
  let ownerChanges = 0;

  await t.test(
    'fleet payload events cannot replace the shared query; revisions refetch it once and errors retain stale facts',
    async (st) => {
      // Automatic fleet rereads are paced; these notices arrive a full interval after the last read.
      const now = performance.now.bind(performance);
      st.mock.method(performance, 'now', () => now() + RESOURCE_REREAD_INTERVAL_MS.slots!);
      const socket = fakeGateway.sockets.at(-1)!;
      const before = socket.sent.filter(({ method }) => method === 'fleet.status').length;
      socket.event('fleet.updated', { fleet: { ...serverFleet, slots: [] } });
      socket.event('slot.changed', { slot: { slot: 'fleet-slot', lifecycle: 'busy' } });
      await flush();
      assert.equal(getState().fleet?.slots[0].lifecycle, 'ready');
      assert.equal(socket.sent.filter(({ method }) => method === 'fleet.status').length, before);
      serverFleet = { ...serverFleet, stale: true };
      fleetRevision++;
      const notice = {
        version: 1,
        epoch: fakeGateway.resourceEpoch,
        changes: [
          { key: { family: 'slots', scope: 'farm' }, revision: fleetRevision, kind: 'updated' },
        ],
      };
      socket.event('resource.changed', notice);
      await flush();
      assert.equal(getState().fleet?.stale, true);
      assert.equal(isFleetCurrent(), false);
      assert.equal(
        socket.sent.filter(({ method }) => method === 'fleet.status').length,
        before + 1,
      );
      socket.event('resource.changed', notice);
      await flush();
      assert.equal(
        socket.sent.filter(({ method }) => method === 'fleet.status').length,
        before + 1,
      );
      answerFleet = false;
      const pending = getResourceCache()!.retry(fleetQuery);
      await flush();
      const request = socket.sent.filter(({ method }) => method === 'fleet.status').at(-1)!;
      socket.failure(request.id, { code: 'METHOD_ERROR', message: 'Fleet source unreadable' });
      await pending;
      assert.equal(getState().fleetObservation.status, 'stale');
      assert.equal(getState().fleetObservation.error?.message, 'Fleet source unreadable');
      assert.equal(getState().fleet?.slots[0].slot, 'fleet-slot');
      assert.equal(isFleetCurrent(), false);
      answerFleet = true;
      serverFleet = { ...serverFleet, stale: undefined };
      await getResourceCache()!.retry(fleetQuery);
      assert.equal(isFleetCurrent(), true);
    },
  );

  await t.test(
    'domain payloads cannot replace collections, while resource changes refetch them once',
    async (st) => {
      // Automatic run list rereads are paced; this notice arrives a full interval after the last read.
      const now = performance.now.bind(performance);
      st.mock.method(performance, 'now', () => now() + activeRunsQuery.rereadIntervalMs!.runs!);
      const socket = fakeGateway.sockets.at(-1)!;
      socket.event('run.updated', { run: makeRun({ id: 'untrusted-event-row' }) });
      socket.event('decision.new', {
        decision: { id: 'untrusted-event-decision', title: 'Event data' },
      });
      await flush();
      assert.deepEqual(
        getState().runs.map(({ id }) => id),
        ['run-1'],
      );
      assert.deepEqual(getState().decisions, []);
      serverRuns = [
        makeRun({ summary: 'Fresh authoritative facts', updatedAt: '2026-10-20T00:00:01.000Z' }),
      ];
      runRevision++;
      const notice = {
        version: 1,
        epoch: fakeGateway.resourceEpoch,
        changes: [
          { key: { family: 'runs', scope: 'farm' }, revision: runRevision, kind: 'updated' },
        ],
      };
      socket.event('resource.changed', notice);
      await flush();
      assert.equal(getState().runs[0]?.summary, 'Fresh authoritative facts');
      assert.equal(getState().runsObservation.status, 'ready');
      const reads = socket.sent.filter(({ method }) => method === 'run.list').length;
      socket.event('resource.changed', notice);
      await flush();
      assert.equal(socket.sent.filter(({ method }) => method === 'run.list').length, reads);
    },
  );

  await t.test('a reconnect with the same principal keeps runs', async () => {
    // A gateway restart or network blip keeps the runs on screen, marked as stale.
    fakeGateway.holdAuth = true;
    fakeGateway.restart();
    await flush();
    assert.notEqual(gateway.connectionState, 'connected');
    assert.deepEqual(
      getState().runs.map((run) => run.id),
      ['run-1'],
    );
    assert.equal(getState().workspaceAccess, 'farm');
    assert.equal(getState().runsObservation.status, 'stale');
    assert.equal(getState().fleetObservation.status, 'stale');
    assert.equal(getState().fleet?.slots[0].slot, 'fleet-slot');
    assert.equal(isFleetCurrent(), false);
    assert.equal(isHydrating(getState(), 'runs'), false);
    t.after(onWorkspaceOwnerChange(() => (ownerChanges += 1)));

    // Reconnecting as the same principal keeps them until the bootstrap replaces them.
    fakeGateway.holdAuth = false;
    gateway.reconnect();
    await flush();
    assert.equal(gateway.connectionState, 'connected');
    assert.equal(gateway.authenticatedPrincipalId, 'operator-a');
    assert.deepEqual(
      getState().runs.map((run) => run.id),
      ['run-1'],
    );
    // The views stay mounted: nothing tears them down for the same account.
    assert.equal(ownerChanges, 0);
  });

  await t.test('a reconnect as a different principal clears', async () => {
    // Reconnecting as a different principal clears the previous account's workspace.
    fakeGateway.principalId = 'operator-b';
    answerRuns = false;
    answerFleet = false;
    fakeGateway.restart();
    gateway.reconnect();
    await flush();
    assert.equal(gateway.connectionState, 'connected');
    assert.equal(gateway.authenticatedPrincipalId, 'operator-b');
    assert.deepEqual(getState().runs, []);
    assert.equal(getState().fleet, null);
    assert.equal(ownerChanges, 1);
  });

  await t.test('a credential change on this client clears at once', async () => {
    // Changing credentials on this client clears at once, before any reconnect.
    serverRuns = [makeRun({ id: 'run-2' })];
    answerRuns = true;
    answerFleet = true;
    const fresh = Promise.all([
      getResourceCache()!.retry(runHistoryQuery),
      getResourceCache()!.retry(activeRunsQuery),
    ]);
    const socket = fakeGateway.sockets.at(-1)!;
    for (const request of socket.sent.filter(({ method }) => method === 'run.list'))
      socket.response(
        request.id,
        { runs: serverRuns, totalCount: serverRuns.length },
        {
          epoch: fakeGateway.resourceEpoch,
          dependencies: [{ key: { family: 'runs', scope: 'farm' }, revision: runRevision }],
        },
      );
    await fresh;
    assert.deepEqual(
      getState().runs.map(({ id }) => id),
      ['run-2'],
    );
    await gateway.setAuthCredentials({ token: 'operator-c-secret' });
    assert.deepEqual(getState().runs, []);
    assert.equal(getState().workspaceAccess, 'none');
    assert.equal(getState().fleet, null);
    assert.equal(ownerChanges, 2);
  });

  await t.test('sign-out clears', async () => {
    serverRuns = [makeRun({ id: 'run-3' })];
    gateway.connect();
    await flush();
    assert.equal(gateway.connectionState, 'connected');
    await gateway.signOut();
    assert.equal(gateway.connectionState, 'auth_required');
    assert.deepEqual(getState().runs, []);
    assert.equal(getState().workspaceAccess, 'none');
    assert.equal(ownerChanges, 4);
  });
});
