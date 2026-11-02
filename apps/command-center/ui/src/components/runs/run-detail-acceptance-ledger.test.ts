import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import { LitElement, type ReactiveControllerHost } from 'lit';

import type { TaskProgressResult } from '@farmslot/protocol';
import { resourceQuery } from '@farmslot/protocol/client-cache';

import { installFakeGateway } from '../../testing/fake-gateway.js';
import type { ResourceQueryController } from '../shared/resource-query-controller.js';

import type { RunDetailState } from './run-detail-state.js';

interface AcceptanceView extends Pick<
  RunDetailState,
  'run' | 'mockData' | '_now' | 'acceptanceStatusError' | '_taskProgressLoading'
> {
  progressQuery: ResourceQueryController<TaskProgressResult>;
  _acceptProgressObservation(): void;
  willUpdate(changed: Map<string, unknown>): void;
}

// These renderers pull CSS and Monaco, which node cannot load.
mock.module('../diff-viewer/diff-review.js', { namedExports: {} });
mock.module('../diff-viewer/code-viewer.js', { namedExports: {} });
mock.module('../terminal/terminal-view.js', { namedExports: {} });

test('the acceptance panel names no superseded ledger read for the grace period', async (t) => {
  const fake = installFakeGateway(t);
  fake.resourceEpoch = 'ledger-epoch';
  // task.progress reads stay open until the test answers or refuses them.
  fake.responseForRequest = ({ method }) =>
    method === 'task.progress' ? undefined : { payload: {} };
  const { gateway } = await import('../../gateway-client.js');
  const { initState } = await import('../../state.js');
  const { disposeResourceCache } = await import('../../resource-cache.js');
  const { ResourceQueryController } = await import('../shared/resource-query-controller.js');
  const { acceptanceLedgerRead } = await import('./run-detail-model.js');
  const { RunDetail } = await import('./run-detail.js');
  assert.ok(RunDetail.prototype instanceof LitElement);
  // Use the component's real methods without connecting a DOM or its other queries.
  const view = Object.create(RunDetail.prototype) as AcceptanceView;
  Object.assign(view, { requestUpdate() {}, mockData: false });
  fake.beforeRestore = async () => {
    gateway.disconnect();
    await disposeResourceCache();
  };
  const flush = async () => {
    for (let i = 0; i < 20; i++) await new Promise<void>((resolve) => setImmediate(resolve));
  };
  initState();
  await gateway.setAuthCredentials({ token: 'test-secret' });
  gateway.connect();
  await flush();
  const host: ReactiveControllerHost = {
    addController() {},
    removeController() {},
    requestUpdate() {},
    updateComplete: Promise.resolve(true),
  };
  const progress = new ResourceQueryController<TaskProgressResult>(host);
  progress.setQuery(
    resourceQuery<TaskProgressResult>('task.progress', { slotId: 'slot-1', runId: 'run-1' }),
  );
  Object.defineProperty(view, 'progressQuery', { value: progress });
  progress.hostConnected();
  await flush();
  const socket = fake.sockets.at(-1)!;
  const lastRead = () => socket.sent.filter(({ method }) => method === 'task.progress').at(-1)!;
  const superseded = {
    code: 'RESOURCE_OBSERVATION_CHANGED',
    message: 'The file observation changed during this read.',
  };

  // A panel that does not belong to this workspace waits.
  assert.deepEqual(acceptanceLedgerRead(undefined), { error: null, pending: true });

  // Nothing held: the panel keeps waiting for the queued reread, and names it after the grace.
  socket.failure(lastRead().id, superseded);
  await flush();
  const since = progress.failingSince;
  assert.ok(since !== undefined);
  view._now = since;
  view._acceptProgressObservation();
  assert.equal(view.acceptanceStatusError, null);
  // willUpdate must adopt the timer even without a new query observation.
  view.run = {
    id: 'run-1',
    familyId: 'family-1',
    lane: 'production',
    flowType: 'fix-bug',
    status: 'monitoring',
    project: 'farmslot-farm',
    ticketOrPr: '1779',
    taskFile: 'task.md',
    slotId: 'slot-1',
    branch: null,
    steps: [],
    decisions: [],
    metrics: { nudgeCount: 0, runner: 'scripted', model: 'scripted' },
    createdAt: '2026-11-02T00:00:00.000Z',
    updatedAt: '2026-11-02T00:00:00.000Z',
  };
  view._taskProgressLoading = true;
  view._now = since + 59_999;
  view.willUpdate(new Map([['_now', since]]));
  assert.equal(view.acceptanceStatusError, null);
  assert.equal(view._taskProgressLoading, true);
  view._now = since + 60_000;
  view.willUpdate(new Map([['_now', since + 59_999]]));
  assert.equal(view.acceptanceStatusError, 'not read yet');
  assert.equal(view._taskProgressLoading, false);
  assert.deepEqual(acceptanceLedgerRead(progress, since), { error: null, pending: true });
  assert.deepEqual(acceptanceLedgerRead(progress, since + 59_999), {
    error: null,
    pending: true,
  });
  assert.deepEqual(acceptanceLedgerRead(progress, since + 60_000), {
    error: 'not read yet',
    pending: false,
  });

  // Held data: a superseded reread names nothing, and the ledger's own error still shows.
  void progress.retry();
  await flush();
  socket.response(
    lastRead().id,
    { slotId: 'slot-1', markdown: '', acceptanceStatusError: 'invalid acceptance-status.json' },
    {
      epoch: fake.resourceEpoch,
      dependencies: (['progress', 'run', 'artifacts'] as const).map((family) => ({
        key: { family, runId: 'run-1' },
        revision: 0,
      })),
    },
  );
  await flush();
  assert.equal(progress.state.status, 'ready');
  void progress.retry();
  await flush();
  socket.failure(lastRead().id, superseded);
  await flush();
  assert.equal(progress.state.status, 'stale');
  view._now = Date.now();
  view._acceptProgressObservation();
  assert.equal(view.acceptanceStatusError, 'invalid acceptance-status.json');
  assert.deepEqual(acceptanceLedgerRead(progress), {
    error: 'invalid acceptance-status.json',
    pending: false,
  });

  // Any other failure is named at once.
  void progress.retry();
  await flush();
  socket.failure(lastRead().id, { code: 'TIMEOUT', message: 'Request task.progress timed out' });
  await flush();
  view._acceptProgressObservation();
  assert.equal(view.acceptanceStatusError, 'Request task.progress timed out');
  assert.deepEqual(acceptanceLedgerRead(progress), {
    error: 'Request task.progress timed out',
    pending: false,
  });
  progress.hostDisconnected();
});
