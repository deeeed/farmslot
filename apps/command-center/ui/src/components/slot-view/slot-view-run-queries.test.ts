import assert from 'node:assert/strict';
import test from 'node:test';

import type { ReactiveController } from 'lit';

import type { Run } from '@farmslot/protocol';
import { resourceQuery, type ResourceReadMethod } from '@farmslot/protocol/client-cache';

import { installFakeGateway } from '../../testing/fake-gateway.js';

import type { SlotView } from './slot-view.js';

test('slot observations preserve exact native pins and reject stale, previous-view and previous-owner inputs', async (t) => {
  const fake = installFakeGateway(t);
  fake.resourceEpoch = 'slot-query-proof';
  const native = {
    id: 'native',
    familyId: 'native',
    slotId: 'slot',
    transport: 'native',
    status: 'monitoring',
    flowType: 'dev',
    project: 'proof',
    ticketOrPr: 'Native proof',
    steps: [],
    decisions: [],
    metrics: {},
    createdAt: '2026-10-20T00:00:00Z',
    updatedAt: '2026-10-20T00:00:00Z',
    agentContexts: [
      {
        id: 'dev',
        role: 'dev',
        label: 'Dev',
        runId: 'native',
        slotId: 'slot',
        target: null,
        nativeSession: { sessionId: 'session', leaseId: 'lease' },
      },
    ],
  } as unknown as Run;
  const next = {
    ...native,
    id: 'next',
    familyId: 'next',
    transport: 'tmux',
    agentContexts: [],
  } as Run;
  const records = new Map([
    ['native', native],
    ['next', next],
  ]);
  let selected = native;
  let hold = false;
  let revision = 0;
  const stamp = (method: ResourceReadMethod, params: unknown) => ({
    epoch: fake.resourceEpoch,
    dependencies: resourceQuery(method, params).dependencies.map((key) => ({ key, revision })),
  });
  fake.responseForRequest = ({ method, params }) => {
    if (['run.forSlot', 'run.get', 'run.recipeRunsForRun'].includes(method)) {
      if (hold) return undefined;
      const payload =
        method === 'run.forSlot'
          ? { run: selected }
          : method === 'run.get'
            ? { run: records.get(Reflect.get(params as object, 'runId')) }
            : { recipeRuns: [], selectedRecipeRunId: null };
      return { payload, resourceState: stamp(method as ResourceReadMethod, params) };
    }
    return { payload: {} };
  };
  const { gateway } = await import('../../gateway-client.js');
  const { initializeResourceCache, disposeResourceCache } = await import('../../resource-cache.js');
  const { SlotViewRunQueries } = await import('./slot-view-run-queries.js');
  const { resetSlotViewRecipePanelState } = await import('./slot-view-recipe-run-effects.js');
  const controllers: ReactiveController[] = [];
  const view = {
    slotId: 'slot',
    isConnected: true,
    _isLive: true,
    _isRecoveryBlocked: false,
    _slot: { currentRunId: 'native' },
    _linkedRun: null,
    addController: (controller: ReactiveController) => controllers.push(controller),
    requestUpdate() {},
    updateComplete: Promise.resolve(true),
    _resetRecipePanelState() {
      resetSlotViewRecipePanelState(this as unknown as SlotView);
    },
    _applyLinkedRun(this: SlotView, run: Run | null) {
      this._linkedRun = run;
      return run?.status ?? null;
    },
    _readyGateDecision: () => null,
    _requestedRecipeRunFromUrl: () => null,
    _requestedRecipeArtifactFromUrl: () => null,
    _requestedRecipeDependencyFromUrl: () => null,
    _loadSelectedRecipeDependency() {},
    _loadSelectedRecipeEvidenceManifest() {},
    _loadSelectedRecipeArtifactPreview() {},
  } as unknown as SlotView;
  const queries = new SlotViewRunQueries(view);
  const flush = async () => {
    for (let i = 0; i < 20; i++) await new Promise<void>((resolve) => setImmediate(resolve));
  };
  fake.beforeRestore = async () => {
    for (const controller of [...controllers].reverse()) controller.hostDisconnected?.();
    gateway.disconnect();
    await disposeResourceCache();
  };
  location.hash = '#slot/slot?runId=native&contextId=unknown';
  initializeResourceCache();
  await gateway.setAuthCredentials({ token: 'slot-proof-secret' });
  gateway.connect();
  await flush();
  for (const controller of controllers) controller.hostConnected?.();
  await flush();
  assert.equal(view._linkedRun, null, 'An unknown native context cannot fall back to the slot run');
  assert.throws(() => queries.requireRun(), /selected run changed/);

  location.hash = '#slot/slot?runId=native&contextId=dev';
  queries.sync();
  await flush();
  assert.equal((view as SlotView)._linkedRun?.id, 'native');
  assert.equal(queries.requireRecipes().id, 'native');
  const canonical = queries.slot.state.data!.run;
  assert.equal(
    view._linkedRun,
    canonical,
    'The rendered value belongs to the actual shared observation',
  );
  const acknowledgement = queries.capture();
  const socket = fake.sockets.at(-1)!;
  socket.event('run.updated', { ...native, ticketOrPr: 'Unstamped domain payload' });
  await flush();
  assert.equal(view._linkedRun, canonical, 'Domain events cannot adopt or refresh a run');

  hold = true;
  revision++;
  socket.event('resource.changed', {
    version: 1,
    epoch: fake.resourceEpoch,
    changes: [{ key: { family: 'slot', slotId: 'slot' }, revision, kind: 'updated' }],
  });
  await flush();
  assert.equal(view._linkedRun, canonical, 'An invalidation keeps the saved run visible');
  assert.equal(view._linkedRunCurrent, false);
  assert.throws(() => queries.requireRun(), /current read/);
  const old = socket.sent.filter(({ method }) => method === 'run.forSlot').at(-1)!;
  socket.failure(old.id, { code: 'READ_FAILED', message: 'Private binding unavailable' });
  await flush();
  assert.equal(view._linkedRunReadError, 'Private binding unavailable');
  assert.equal(
    view._linkedRun,
    canonical,
    'A read failure keeps saved facts without granting action readiness',
  );

  hold = false;
  selected = next;
  view._slot!.currentRunId = 'next';
  location.hash = '#slot/slot?runId=next';
  queries.sync();
  await queries.retry();
  await flush();
  assert.equal(queries.requireRun().id, 'next');
  assert.equal(
    acknowledgement(),
    false,
    'A previous view acknowledgement cannot act on its replacement',
  );

  hold = true;
  await gateway.setAuthCredentials({ token: 'new-owner-secret' });
  await flush();
  assert.equal(
    view._linkedRun,
    null,
    'Previous-owner observations cannot populate a new workspace',
  );
  assert.throws(() => queries.requireRun(), /current read/);
});
