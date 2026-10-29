import assert from 'node:assert/strict';
import test from 'node:test';

import type { RunDecision } from '@farmslot/protocol';

import { FakeControllerHost } from '../../testing/fake-controller-host.js';
import { installFakeGateway } from '../../testing/fake-gateway.js';

import type { ReadyWorkspaceActionPresenter } from './ready-workspace-action-presenter.js';

test('gate observers share frozen reads, invalidate confirmations and retire owner-bound replies', async (t) => {
  const fake = installFakeGateway(t);
  fake.resourceEpoch = 'workspace-epoch';
  let revision = 0;
  let holdEvidence = false;
  let holdRun = false;
  const requests: Array<{ method: string; params: unknown }> = [];
  let packageHash = 'first-package';
  const decision = (): RunDecision => ({
    id: 'gate',
    type: 'engine_human_gate',
    title: 'Gate',
    description: '',
    actions: [],
    createdAt: '2026-10-22T00:00:00Z',
    payload: { kind: 'ready', prPackage: { packageHash } } as RunDecision['payload'],
  });
  const stamp = (runId: string) => ({
    epoch: fake.resourceEpoch,
    dependencies: [
      { key: { family: 'runs', scope: 'farm' }, revision },
      { key: { family: 'run', runId }, revision },
      { key: { family: 'artifacts', runId }, revision },
    ],
  });
  fake.responseForRequest = ({ method, params }) => {
    requests.push({ method, params });
    const runId = Reflect.get(params ?? {}, 'runId') ?? 'run-a';
    if (method === 'run.get')
      return holdRun
        ? undefined
        : {
            payload: { run: { id: runId, decisions: [decision()] } },
            resourceState: stamp(runId),
          };
    if (method === 'run.recipeRunsForRun')
      return holdEvidence
        ? undefined
        : {
            payload: { recipeRuns: [], selectedRecipeRunId: null },
            resourceState: stamp(runId),
          };
    return { payload: {} };
  };
  const { gateway } = await import('../../gateway-client.js');
  const { initState } = await import('../../state.js');
  const { disposeResourceCache } = await import('../../resource-cache.js');
  const { ReadyWorkspaceQueries } = await import('./ready-workspace-queries.js');
  const flush = async () => {
    for (let i = 0; i < 20; i++) await new Promise<void>((resolve) => setImmediate(resolve));
  };
  fake.beforeRestore = async () => {
    gateway.disconnect();
    await disposeResourceCache();
  };
  initState();
  await gateway.setAuthCredentials({ token: 'test-secret' });
  gateway.connect();
  await flush();
  const makeView = () =>
    Object.assign(new FakeControllerHost(), {
      isConnected: true,
      runId: 'run-a',
      slotId: 'slot-a',
      decision: decision(),
      _usesMockData: false,
      _pendingConfirm: 'approve',
      _confirmTimer: { clear() {} },
      _retireWorkspaceCommands() {
        this._pendingConfirm = '';
      },
      _sharedWorkspaceQueriesChanged() {
        return undefined;
      },
    });
  const first = makeView();
  const second = makeView();
  const queries = new ReadyWorkspaceQueries(first as unknown as ReadyWorkspaceActionPresenter);
  const other = new ReadyWorkspaceQueries(second as unknown as ReadyWorkspaceActionPresenter);
  first.connect();
  second.connect();
  await flush();
  assert.equal(queries.ready, true);
  assert.equal(queries.evidence.state, other.evidence.state);
  const socket = fake.sockets.at(-1)!;
  const evidenceReads = () => requests.filter(({ method }) => method === 'run.recipeRunsForRun');
  assert.equal(evidenceReads().length, 1);
  assert.deepEqual(evidenceReads()[0].params, {
    runId: 'run-a',
    decisionId: 'gate',
    includeRecordedEvidence: true,
    evidenceSnapshotHash: 'first-package',
  });
  const captured = queries.capture();
  first._pendingConfirm = 'approve';
  holdEvidence = true;
  revision++;
  packageHash = 'replacement-package';
  socket.event('resource.changed', {
    version: 1,
    epoch: fake.resourceEpoch,
    changes: [{ key: { family: 'run', runId: 'run-a' }, revision, kind: 'updated' }],
  });
  await flush();
  assert.equal(queries.ready, false);
  assert.equal(first._pendingConfirm, null);
  assert.throws(() => queries.requireDecision(), /current read/);
  assert.equal(
    Reflect.get(evidenceReads().at(-1)!.params as object, 'evidenceSnapshotHash'),
    'replacement-package',
  );
  holdEvidence = false;
  for (const request of socket.sent.filter(({ method }) => method === 'run.recipeRunsForRun'))
    socket.response(request.id, { recipeRuns: [], selectedRecipeRunId: null }, stamp('run-a'));
  await flush();
  await queries.evidence.retry();
  await flush();
  assert.equal(queries.requireDecision().payload?.kind, 'ready');
  await t.test('retained resolved metadata cannot reopen command authority', () => {
    first.decision = {
      ...decision(),
      resolvedAt: '2026-10-30T00:00:00Z',
      resolvedAction: 'approve-publish',
    };
    assert.equal(queries.decision?.resolvedAt, first.decision.resolvedAt);
    assert.equal(queries.run.requireReady().run.decisions[0].resolvedAt, undefined);
    assert.throws(() => queries.requireDecision(), /gate changed/);
    first.decision = decision();
  });
  first.runId = 'run-b';
  assert.equal(captured.current(), false);
  assert.equal(captured.ownsView(), false);
  queries.sync();
  await flush();
  const beforeOwner = queries.capture();
  holdRun = true;
  holdEvidence = true;
  await gateway.setAuthCredentials({ token: 'different-secret' });
  await flush();
  assert.equal(beforeOwner.current(), false);
  assert.equal(queries.decision, undefined);
  assert.throws(() => queries.requireDecision(), /current read/);
  first.disconnect();
  second.disconnect();
});
