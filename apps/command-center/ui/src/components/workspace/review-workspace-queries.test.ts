import assert from 'node:assert/strict';
import test from 'node:test';

import type { RunDecision } from '@farmslot/protocol';

import { FakeControllerHost } from '../../testing/fake-controller-host.js';
import { installFakeGateway } from '../../testing/fake-gateway.js';

test('review inputs share canonical reads, retire stale confirmations and preserve admitted reply ownership', async (t) => {
  const fake = installFakeGateway(t);
  fake.resourceEpoch = 'review-epoch';
  let revision = 0;
  let hold = false;
  let actions = ['post', 'dismiss'];
  let report = 'Current saved review';
  let slotOwner = 'run-a';
  const requests: string[] = [];
  const decision = (): RunDecision => ({
    id: 'review-gate',
    type: 'engine_review_posting',
    title: 'Review',
    description: '',
    createdAt: '2026-10-22T00:00:00Z',
    actions: actions.map((id) => ({ id, label: id, style: 'primary' })),
    payload: {
      kind: 'review',
      reviewMd: report,
      recommendation: 'COMMENT',
      lineComments: [],
      prNumber: null,
      repo: null,
    },
  });
  const stamp = (runId: string) => ({
    epoch: fake.resourceEpoch,
    dependencies: [
      { key: { family: 'runs', scope: 'farm' }, revision },
      { key: { family: 'run', runId }, revision },
      { key: { family: 'slot', slotId: 'slot-a' }, revision },
    ],
  });
  const reply = (runId: string) => ({
    run: {
      id: runId,
      slotId: 'slot-a',
      ticketOrPr: 'owner/repo#1',
      createdAt: '2026-10-22T00:00:00Z',
      decisions: [decision()],
      reviewResult: decision().payload,
    },
  });
  fake.responseForRequest = ({ method, params }) => {
    requests.push(method);
    const runId = Reflect.get(params ?? {}, 'runId') ?? 'run-a';
    return method === 'run.get' || method === 'run.forSlot'
      ? hold
        ? undefined
        : {
            payload: reply(method === 'run.forSlot' ? slotOwner : runId),
            resourceState: stamp(runId),
          }
      : { payload: {} };
  };
  const { gateway } = await import('../../gateway-client.js');
  const { initState } = await import('../../state.js');
  const { disposeResourceCache } = await import('../../resource-cache.js');
  const { ReviewWorkspaceQueries } = await import('./review-workspace-queries.js');
  const flush = async () => {
    for (let i = 0; i < 20; i++) await new Promise<void>((resolve) => setImmediate(resolve));
  };
  fake.beforeRestore = async () => {
    gateway.disconnect();
    await disposeResourceCache();
  };
  initState();
  await gateway.setAuthCredentials({ token: 'review-test-secret' });
  gateway.connect();
  await flush();
  const view = () => {
    const host = Object.assign(new FakeControllerHost(), {
      isConnected: true,
      runId: 'run-a',
      slotId: 'slot-a',
      decision: decision(),
      readOnly: false,
      workspaceView: false,
      _usesMockData: false,
      confirmation: true,
      retired: 0,
      changes: 0,
      _confirmTimer: { clear() {} },
      _retireReviewScope() {
        this.retired++;
      },
      _reviewInputsChanged() {
        this.changes++;
      },
    });
    host._confirmTimer.clear = () => {
      host.confirmation = false;
    };
    return host;
  };
  const first = view();
  const second = view();
  const queries = new ReviewWorkspaceQueries(first);
  const other = new ReviewWorkspaceQueries(second);
  first.connect();
  second.connect();
  await flush();
  assert(queries.ready);
  queries.requireSlot();
  assert.equal(queries.run.state, other.run.state);
  assert.equal(requests.filter((method) => method === 'run.get').length, 1);
  assert.notEqual(
    queries.requireDecision('post'),
    first.decision,
    'Commands use the canonical full-run decision',
  );
  const admitted = queries.capture();
  const socket = fake.sockets.at(-1)!;
  const changeSlot = async () => {
    revision++;
    socket.event('resource.changed', {
      version: 1,
      epoch: fake.resourceEpoch,
      changes: [{ key: { family: 'slot', slotId: 'slot-a' }, revision, kind: 'updated' }],
    });
    await flush();
  };
  slotOwner = 'replacement-worker';
  await changeSlot();
  assert.throws(() => queries.requireSlot(), /no longer belongs/);
  assert.equal(
    queries.requireDecision('post').id,
    'review-gate',
    'Posting does not require retaining a live worker slot',
  );
  slotOwner = 'run-a';
  await changeSlot();
  queries.requireSlot();
  const invalidate = () => {
    revision++;
    socket.event('resource.changed', {
      version: 1,
      epoch: fake.resourceEpoch,
      changes: [{ key: { family: 'run', runId: 'run-a' }, revision, kind: 'updated' }],
    });
  };
  first.confirmation = true;
  hold = true;
  invalidate();
  await flush();
  assert.equal(queries.ready, false);
  assert.equal(first.confirmation, false);
  assert.throws(() => queries.requireDecision('post'), /current read/);
  assert(admitted.current(), 'Ordinary staleness does not detach an already admitted command');
  hold = false;
  actions = ['dismiss'];
  report = 'Replacement review';
  for (const request of socket.sent.filter(({ method }) => method === 'run.get'))
    socket.response(request.id, reply('run-a'), stamp('run-a'));
  await flush();
  assert.equal(queries.requireDecision('dismiss').payload?.kind, 'review');
  assert.throws(() => queries.requireDecision('post'), /no longer available/);
  first.readOnly = true;
  first.decision = { ...first.decision, id: 'saved-run-a' };
  queries.sync();
  await flush();
  assert.equal(queries.decision?.payload?.kind, 'review');
  assert.equal(
    queries.decision?.payload && Reflect.get(queries.decision.payload, 'reviewMd'),
    report,
  );
  assert.throws(() => queries.requireDecision(), /no longer available/);
  assert.equal(admitted.current(), false, 'Changing view mode retires the former command owner');
  const beforeSwitch = queries.capture();
  first.runId = 'run-b';
  queries.sync();
  await flush();
  assert.equal(beforeSwitch.ownsView(), false);
  const beforeOwner = queries.capture();
  hold = true;
  await gateway.setAuthCredentials({ token: 'replacement-review-secret' });
  await flush();
  assert.equal(beforeOwner.current(), false);
  assert.equal(queries.decision, undefined, 'A parent prop cannot restore a revoked owner result');
  first.disconnect();
  second.disconnect();
});
