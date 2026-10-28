import assert from 'node:assert/strict';
import test from 'node:test';

import type { RunDecision } from '@farmslot/protocol';

import { FakeControllerHost } from '../../testing/fake-controller-host.js';
import { installFakeGateway } from '../../testing/fake-gateway.js';

import type { ReadyWorkspaceActionPresenter } from './ready-workspace-action-presenter.js';

test('a stored gate snapshot shows the gate until the ordinary run.get lands', async (t) => {
  // Lit's server entry initializes before the gateway fixture supplies its minimal document.
  await import('lit');
  const fake = installFakeGateway(t);
  fake.resourceEpoch = 'snapshot-epoch';
  let holdOrdinary = true;
  const decision = (packageHash: string): RunDecision => ({
    id: 'gate',
    type: 'engine_human_gate',
    title: 'Gate',
    description: '',
    actions: [],
    createdAt: '2026-10-28T00:00:00Z',
    payload: { kind: 'ready', prPackage: { packageHash } } as RunDecision['payload'],
  });
  const stamp = {
    epoch: fake.resourceEpoch,
    dependencies: [
      { key: { family: 'runs', scope: 'farm' }, revision: 0 },
      { key: { family: 'run', runId: 'run-a' }, revision: 0 },
      { key: { family: 'artifacts', runId: 'run-a' }, revision: 0 },
    ],
  };
  fake.responseForRequest = ({ method, params }) => {
    if (method === 'run.get') {
      if (Reflect.get(params ?? {}, 'view') === 'snapshot')
        return {
          payload: { run: { id: 'run-a', decisions: [decision('stored-package')] } },
          resourceState: stamp,
        };
      return holdOrdinary
        ? undefined
        : {
            payload: { run: { id: 'run-a', decisions: [decision('current-package')] } },
            resourceState: stamp,
          };
    }
    if (method === 'run.recipeRunsForRun')
      return { payload: { recipeRuns: [], selectedRecipeRunId: null }, resourceState: stamp };
    return { payload: {} };
  };
  const { gateway } = await import('../../gateway-client.js');
  const { initState } = await import('../../state.js');
  const { disposeResourceCache } = await import('../../resource-cache.js');
  const { ReadyWorkspaceQueries } = await import('./ready-workspace-queries.js');
  const { ReadyWorkspaceActionPresenter: Presenter } =
    await import('./ready-workspace-action-presenter.js');
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
  const host = Object.assign(new FakeControllerHost(), {
    isConnected: true,
    runId: 'run-a',
    slotId: 'slot-a',
    decision: decision('host-copy'),
    _usesMockData: false,
    _pendingConfirm: null,
    _confirmTimer: { clear() {} },
    _retireWorkspaceCommands() {},
    _sharedWorkspaceQueriesChanged() {},
  });
  const queries = new ReadyWorkspaceQueries(host as unknown as ReadyWorkspaceActionPresenter);
  host.connect();
  await flush();
  // The presenter's gate and command checks, over the same queries the workspace renders.
  const view = Object.create(Presenter.prototype) as ReadyWorkspaceActionPresenter;
  Object.assign(view, {
    requestUpdate: () => undefined,
    runId: 'run-a',
    decision: host.decision,
    actionsBlocked: false,
    _queries: queries,
    _recoveryPhase: 'live',
    _acting: false,
    _refreshingPackage: false,
  });
  Object.defineProperty(view, '_usesMockData', { value: false });
  const resolveSent = () => fake.requests.filter(({ method }) => method === 'run.resolveDecision');
  const assertCommandsWait = () => {
    assert.equal(view._actionsPaused, true);
    assert.throws(() => queries.requireDecision(), /current read/);
    assert.equal(view._beginWorkspaceCommand(), undefined);
    assert.match(view._actionMessage, /Wait for current run and evidence reads/);
    assert.deepEqual(resolveSent(), []);
  };

  await t.test('the snapshot shows the gate while run.get is pending', () => {
    assert.equal(queries.showsSnapshot, true);
    assert.equal(queries.ready, false);
    assert.equal(view._payload?.prPackage?.packageHash, 'stored-package');
    assertCommandsWait();
  });

  await t.test('the snapshot still shows the gate after run.get fails', async () => {
    const ordinary = fake.requests.find(
      ({ method, params }) => method === 'run.get' && !Reflect.get(params ?? {}, 'view'),
    );
    assert.ok(ordinary);
    fake.sockets
      .at(-1)!
      .failure(ordinary.id, { code: 'WORKER_UNREACHABLE', message: 'Worker unreachable' });
    await flush();
    assert.equal(queries.run.state.error?.message, 'Worker unreachable');
    assert.equal(queries.showsSnapshot, true);
    assert.equal(view._payload?.prPackage?.packageHash, 'stored-package');
    assertCommandsWait();
  });

  await t.test('the ordinary run.get decision wins once it lands', async () => {
    holdOrdinary = false;
    await queries.run.retry();
    await flush();
    assert.equal(queries.showsSnapshot, false);
    assert.equal(view._payload?.prPackage?.packageHash, 'current-package');
    assert.equal(queries.ready, true);
    const current = queries.requireDecision();
    assert.equal(
      current.payload?.kind === 'ready' ? current.payload.prPackage?.packageHash : undefined,
      'current-package',
    );
    assert.equal(view._actionsPaused, false);
  });
  host.disconnect();
});
