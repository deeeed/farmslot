import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { PRMonitorConfig, PRMonitorObservation } from '@farmslot/protocol';

import { getQueueSnapshot, removeQueueItemInternalNow } from '../backlog/dispatch-queue.js';
import { createRun, deleteRun, persistRunNow, updateRun } from '../runs/store.js';

import { PRRepairDispatcher } from './dispatch.js';
import { planMonitorRepair } from './repair-plan.js';
import { PRMonitorStore } from './store.js';

const execution = {
  slotPolicy: { kind: 'exact' as const, slotId: 'repair-slot' },
  models: [{ runner: 'codex', model: 'gpt-6-astra', effort: 'high' }],
};
const config: PRMonitorConfig = {
  pr: { host: 'github.com', repo: 'owner/repo', number: 501 },
  account: { host: 'github.com', login: 'reader' },
  project: 'project',
  policy: { mode: 'automatic-repair', execution },
  pollIntervalMs: 300_000,
  watchedChecks: [],
  automaticAttemptLimit: 2,
  cooldownMs: 60_000,
};
function observation(): PRMonitorObservation {
  return {
    checkedAt: new Date().toISOString(),
    headSha: 'head-a',
    title: 'PR',
    author: 'author',
    state: 'open',
    draft: false,
    mergeability: 'mergeable',
    reviewDecision: 'changes-requested',
    repairAccess: { allowed: true, headRepository: 'owner/repo', headBranch: 'fix/example' },
    signals: [
      {
        key: 'review-1',
        revision: 'revision-1',
        kind: 'review',
        summary: 'Changes requested',
        url: 'https://github.com/owner/repo/pull/501',
      },
      {
        key: 'check-1',
        revision: 'attempt-1',
        kind: 'check',
        summary: 'CI failed',
        url: 'https://github.com/owner/repo/pull/501',
      },
    ],
  };
}
async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'pr-repair-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'monitors.json');
  const store = await PRMonitorStore.load(file);
  const monitor = await store.subscribe('owner', config);
  await store.observe(monitor.id, 'owner', monitor.revision, { observation: observation() });
  t.after(async () => {
    for (const item of getQueueSnapshot().filter((entry) =>
      store.snapshot().monitors.some((owned) => entry.prWork?.sourceId === owned.id),
    ))
      await removeQueueItemInternalNow(item.id, 'test-cleanup');
  });
  const dispatcher = (current: PRMonitorStore) =>
    new PRRepairDispatcher(
      current,
      { refresh: async () => current.get(monitor.id, 'owner') },
      () => true,
      () => {},
      async () => ({
        choices: [{ slotId: 'repair-slot', runner: 'codex', model: 'gpt-6-astra', effort: 'high' }],
        errors: [],
      }),
    );
  return {
    file,
    store,
    monitor,
    dispatcher: dispatcher(store),
    restarted: async () => {
      const current = await PRMonitorStore.load(file);
      return { store: current, dispatcher: dispatcher(current) };
    },
  };
}

test('repair-produced check heads retain limits and cooldown after restart without hiding new evidence', async (t) => {
  const { store, monitor, file } = await fixture(t);
  let current = store.get(monitor.id, 'owner');
  current = await store.configure(current.id, 'owner', current.revision, {
    ...config,
    automaticAttemptLimit: 1,
  });
  let collectedAt = Date.now();
  const failing = (headSha: string, attempt: string): PRMonitorObservation => ({
    ...observation(),
    checkedAt: new Date((collectedAt += 10)).toISOString(),
    headSha,
    signals: [
      {
        kind: 'check',
        key: attempt,
        revision: attempt,
        checkName: 'unit',
        summary: 'Unit failed',
        url: 'https://github.com/owner/repo/pull/501',
      },
    ],
  });
  await store.observe(current.id, 'owner', current.revision, {
    observation: failing('head-a', 'check-a'),
  });
  const repair = await store.ensureRepair(current.id, 'owner');
  assert(repair);
  await store.updateRepair(
    current.id,
    'owner',
    repair.id,
    { runId: 'repair-run-a', state: 'running' },
    { countAttempt: true },
  );
  await store.updateRepair(current.id, 'owner', repair.id, { state: 'finished' });
  current = store.get(current.id, 'owner');
  await store.observe(current.id, 'owner', current.revision, {
    observation: failing('repair-head-b', 'check-b'),
  });
  const restarted = await PRMonitorStore.load(file);
  await restarted.reconcileRepairHistory();
  assert.equal(await restarted.ensureRepair(current.id, 'owner'), undefined);
  let latest = restarted.get(current.id, 'owner');
  const incident = latest.incidents.find((entry) => entry.signal.key === 'check-b')!;
  assert.equal(incident.attemptCount, 1);
  assert.match(incident.waitingReason ?? '', /attempt limit/);
  latest = await restarted.configure(latest.id, 'owner', latest.revision, {
    ...config,
    automaticAttemptLimit: 3,
  });
  assert.equal(await restarted.ensureRepair(latest.id, 'owner'), undefined);
  assert.match(
    restarted.get(latest.id, 'owner').incidents.find((entry) => entry.id === incident.id)
      ?.waitingReason ?? '',
    /cooldown/,
  );
  const other = await restarted.subscribe('other-owner', config);
  await restarted.observe(other.id, 'other-owner', other.revision, {
    observation: failing('repair-head-b', 'check-b'),
  });
  await restarted.reconcileRepairHistory();
  const shared = restarted.get(other.id, 'other-owner').incidents[0];
  assert.equal(
    shared.attemptCount,
    1,
    'A subscription joining a later attempt shares the failure budget',
  );
  assert.equal(shared.runId, undefined, 'Shared accounting does not expose another owner’s run');
  latest = restarted.get(latest.id, 'owner');
  await restarted.observe(latest.id, 'owner', latest.revision, {
    observation: {
      ...failing('repair-head-b', 'check-b'),
      signals: [],
      checks: [{ key: 'check-b', name: 'unit', status: 'passed', url: config.pr.repo }],
    },
  });
  // This subscriber has no incident when recovery happens. Its delayed old
  // response is stamped after the passing poll, as the real collector does.
  let delayed = await restarted.subscribe('delayed-owner', config);
  await restarted.observe(delayed.id, 'delayed-owner', delayed.revision, {
    observation: failing('repair-head-b', 'check-b'),
  });
  await restarted.reconcileRepairHistory();
  delayed = restarted.get(delayed.id, 'delayed-owner');
  assert.equal(delayed.incidents[0].attemptCount, 1);
  assert(
    delayed.incidents[0].repairChainClosedAt,
    'Identical old incident inherits known recovery regardless of collection time',
  );
  await restarted.observe(delayed.id, 'delayed-owner', delayed.revision, {
    observation: failing('external-head-c', 'check-c'),
  });
  latest = restarted.get(latest.id, 'owner');
  await restarted.observe(latest.id, 'owner', latest.revision, {
    observation: failing('external-head-c', 'check-c'),
  });
  await restarted.reconcileRepairHistory();
  assert.equal(
    restarted.get(latest.id, 'owner').incidents.at(-1)?.attemptCount,
    0,
    'Confirmed recovery separates a later failure from the old shared budget',
  );
  assert(await restarted.ensureRepair(latest.id, 'owner'));
  const catchingUp = restarted.get(other.id, 'other-owner');
  await restarted.observe(catchingUp.id, 'other-owner', catchingUp.revision, {
    observation: failing('external-head-c', 'check-c'),
  });
  await restarted.reconcileRepairHistory();
  assert.equal(
    restarted.get(latest.id, 'owner').incidents.at(-1)?.attemptCount,
    0,
    'A subscription missing the passing poll cannot reconnect a closed failure chain',
  );
  assert.equal(restarted.get(other.id, 'other-owner').incidents.at(-1)?.attemptCount, 0);
  assert.equal(restarted.get(delayed.id, 'delayed-owner').incidents.at(-1)?.attemptCount, 0);
});

test('concurrent observations plan one repair, which survives queue-link restart without attempts charged', async (t) => {
  const { store, monitor, dispatcher, restarted } = await fixture(t);
  const requests = await Promise.all([
    store.ensureRepair(monitor.id, 'owner'),
    store.ensureRepair(monitor.id, 'owner'),
  ]);
  assert.equal(requests[0]?.id, requests[1]?.id);
  await dispatcher.reconcile();
  assert.equal(getQueueSnapshot().filter((item) => item.prWork?.sourceId === monitor.id).length, 1);
  assert(store.get(monitor.id, 'owner').incidents.every((incident) => incident.attemptCount === 0));
  const next = await restarted();
  await next.dispatcher.reconcile();
  assert.equal(getQueueSnapshot().filter((item) => item.prWork?.sourceId === monitor.id).length, 1);
});

test('policy downgrade withdraws queued automatic work and does not start another repair', async (t) => {
  const { store, monitor, dispatcher } = await fixture(t);
  await dispatcher.reconcile();
  const current = store.get(monitor.id, 'owner');
  await store.configure(monitor.id, 'owner', current.revision, {
    ...config,
    policy: { mode: 'notify-only' },
  });
  await dispatcher.reconcile();
  await dispatcher.reconcile();
  assert.equal(getQueueSnapshot().filter((item) => item.prWork?.sourceId === monitor.id).length, 0);
  assert.equal(store.get(monitor.id, 'owner').repairs?.length, 1);
  assert.equal(store.get(monitor.id, 'owner').repairs?.[0].state, 'cancelled');
});

test('queue removal requires explicit resumption for those incidents', async (t) => {
  const { store, monitor, dispatcher } = await fixture(t);
  await dispatcher.reconcile();
  const request = store.get(monitor.id, 'owner').repairs![0];
  await removeQueueItemInternalNow(request.queueItemId!, 'operator-remove');
  await dispatcher.reconcile();
  await dispatcher.reconcile();
  assert.equal(store.get(monitor.id, 'owner').repairs?.length, 1);
  assert(store.get(monitor.id, 'owner').incidents.every((incident) => incident.resumeCondition));
  assert.equal(getQueueSnapshot().filter((item) => item.prWork?.sourceId === monitor.id).length, 0);
});

test('successful feedback handling stays unresolved on GitHub and does not clear failing checks', async (t) => {
  const { store, monitor } = await fixture(t);
  const request = await store.ensureRepair(monitor.id, 'owner');
  assert(request);
  await store.updateRepair(
    monitor.id,
    'owner',
    request.id,
    { state: 'running', runId: 'repair-run' },
    { countAttempt: true },
  );
  await store.updateRepair(
    monitor.id,
    'owner',
    request.id,
    { state: 'running', runId: 'repair-run' },
    { countAttempt: true },
  );
  await store.updateRepair(
    monitor.id,
    'owner',
    request.id,
    { state: 'finished', completedAt: new Date().toISOString() },
    { handledFeedback: true },
  );
  const current = store.get(monitor.id, 'owner');
  assert(
    current.incidents.every((incident) => incident.attemptCount === 1 && !incident.resolvedAt),
  );
  assert(current.incidents.find((incident) => incident.signal.kind === 'review')?.handledAt);
  assert.equal(
    current.incidents.find((incident) => incident.signal.kind === 'check')?.handledAt,
    undefined,
  );
  const next = planMonitorRepair(current, undefined, Date.now() + 60_001);
  assert.equal(next?.incidentIds.length, 1);
  assert.equal(
    current.incidents.find((incident) => incident.id === next?.incidentIds[0])?.signal.kind,
    'check',
  );
});

test('attempt limits and handled revisions are shared across subscriptions without sharing private run links', async (t) => {
  const { store, monitor } = await fixture(t);
  const other = await store.subscribe('other-owner', config);
  await store.observe(other.id, 'other-owner', other.revision, { observation: observation() });
  const request = await store.ensureRepair(monitor.id, 'owner');
  assert(request);
  await store.updateRepair(
    monitor.id,
    'owner',
    request.id,
    { state: 'running', runId: 'private-run' },
    { countAttempt: true },
  );
  await store.updateRepair(
    monitor.id,
    'owner',
    request.id,
    { state: 'finished', completedAt: new Date().toISOString() },
    { handledFeedback: true },
  );
  await store.reconcileRepairHistory();
  const shared = store.get(other.id, 'other-owner');
  assert(shared.incidents.every((incident) => incident.attemptCount === 1 && !incident.runId));
  assert(shared.incidents.find((incident) => incident.signal.kind === 'review')?.handledAt);
  assert.equal(shared.repairs, undefined);
});

test('unwritable external branches stay actionable without creating queue work', async (t) => {
  const { store, monitor, dispatcher } = await fixture(t);
  const current = store.get(monitor.id, 'owner');
  await store.observe(monitor.id, 'owner', current.revision, {
    observation: {
      ...observation(),
      repairAccess: { allowed: false, reason: 'Fork branch is not writable' },
    },
  });
  await dispatcher.reconcile();
  assert.equal(store.get(monitor.id, 'owner').repairs?.[0].state, 'blocked');
  assert.match(store.get(monitor.id, 'owner').repairs?.[0].waitingReason ?? '', /not writable/);
  assert.equal(getQueueSnapshot().filter((item) => item.prWork?.sourceId === monitor.id).length, 0);
});

test('new same-head incidents rebuild queued worker instructions and frozen handoff bounds attempt accounting', async (t) => {
  const { store, monitor, dispatcher } = await fixture(t);
  await dispatcher.reconcile();
  const first = getQueueSnapshot().find((item) => item.prWork?.sourceId === monitor.id)!;
  const current = store.get(monitor.id, 'owner');
  await store.observe(monitor.id, 'owner', current.revision, {
    observation: {
      ...observation(),
      signals: [
        ...observation().signals,
        {
          key: 'review-2',
          revision: 'revision-2',
          kind: 'feedback',
          summary: 'New feedback',
          url: 'https://github.com/owner/repo/pull/501',
        },
      ],
    },
  });
  await dispatcher.reconcile();
  const second = getQueueSnapshot().find((item) => item.prWork?.sourceId === monitor.id)!;
  const added = store
    .get(monitor.id, 'owner')
    .incidents.find((incident) => incident.signal.key === 'review-2')!;
  assert.notEqual(second.id, first.id);
  assert(second.initialContext?.includes(added.id));
  assert(second.prWork?.incidentIds?.includes(added.id));
  const repair = store.get(monitor.id, 'owner').repairs![0];
  await store.updateRepair(
    monitor.id,
    'owner',
    repair.id,
    { state: 'running', runId: 'frozen-run' },
    { countAttempt: true, frozenIncidentIds: first.prWork!.incidentIds },
  );
  const bound = store.get(monitor.id, 'owner');
  assert.equal(bound.incidents.find((incident) => incident.id === added.id)?.attemptCount, 0);
  assert.deepEqual(bound.repairs![0].incidentIds, first.prWork!.incidentIds);
});

test('completed feedback is shared before another subscription plans work in the same tick', async (t) => {
  const { store, monitor, dispatcher } = await fixture(t);
  const onlyReview = {
    ...observation(),
    signals: observation().signals.filter((signal) => signal.kind === 'review'),
  };
  await store.observe(monitor.id, 'owner', store.get(monitor.id, 'owner').revision, {
    observation: onlyReview,
  });
  const other = await store.subscribe('other-owner', config);
  await store.observe(other.id, 'other-owner', other.revision, { observation: onlyReview });
  await dispatcher.reconcile();
  const queued = getQueueSnapshot().find((item) => item.prWork?.sourceId === monitor.id)!;
  const run = createRun(
    { flowType: 'pr-complete', project: 'project', ticketOrPr: 'owner/repo#501' },
    { deferBackgroundPersist: true },
  );
  run.prWork = queued.prWork;
  await persistRunNow(run, 'repair-test');
  await dispatcher.created(queued, run);
  updateRun(run.id, { status: 'done', completedAt: new Date().toISOString() });
  await persistRunNow(run, 'repair-test-done');
  t.after(async () => {
    updateRun(run.id, { status: 'done' });
    await deleteRun(run.id);
  });
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 60_001 });
  await dispatcher.reconcile();
  assert(store.get(other.id, 'other-owner').incidents[0].handledAt);
  assert.equal(getQueueSnapshot().filter((item) => item.prWork?.kind === 'repair').length, 0);
});

test('an already-blocked request cannot bypass an attempt limit learned from another subscription', async (t) => {
  const { store, monitor, dispatcher } = await fixture(t);
  let current = store.get(monitor.id, 'owner');
  await store.configure(monitor.id, 'owner', current.revision, {
    ...config,
    automaticAttemptLimit: 1,
  });
  const onlyCheck = {
    ...observation(),
    signals: observation().signals.filter((signal) => signal.kind === 'check'),
  };
  current = store.get(monitor.id, 'owner');
  await store.observe(monitor.id, 'owner', current.revision, { observation: onlyCheck });
  const other = await store.subscribe('other-owner', { ...config, automaticAttemptLimit: 1 });
  await store.observe(other.id, 'other-owner', other.revision, { observation: onlyCheck });
  await dispatcher.reconcile();
  assert.equal(store.get(other.id, 'other-owner').repairs?.[0].state, 'blocked');
  const queued = getQueueSnapshot().find((item) => item.prWork?.sourceId === monitor.id)!;
  const run = createRun(
    { flowType: 'pr-complete', project: 'project', ticketOrPr: 'owner/repo#501' },
    { deferBackgroundPersist: true },
  );
  run.prWork = queued.prWork;
  await persistRunNow(run, 'repair-test');
  await dispatcher.created(queued, run);
  updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
  await persistRunNow(run, 'repair-test-failed');
  t.after(async () => {
    updateRun(run.id, { status: 'done' });
    await deleteRun(run.id);
  });
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 60_001 });
  await dispatcher.reconcile();
  assert.equal(getQueueSnapshot().filter((item) => item.prWork?.kind === 'repair').length, 0);
  assert.equal(store.get(other.id, 'other-owner').incidents[0].attemptCount, 1);
  assert.match(store.get(other.id, 'other-owner').repairs?.[0].waitingReason ?? '', /limit/);
});

test('manual repair prunes resolved incidents and rebuilds its queue without importing new feedback', async (t) => {
  const { store, monitor, dispatcher } = await fixture(t);
  await store.ensureRepair(monitor.id, 'owner', { project: 'project', execution });
  await dispatcher.reconcile();
  const first = getQueueSnapshot().find((item) => item.prWork?.sourceId === monitor.id)!;
  const current = store.get(monitor.id, 'owner');
  const check = current.incidents.find((incident) => incident.signal.kind === 'check')!;
  await store.observe(monitor.id, 'owner', current.revision, {
    observation: {
      ...observation(),
      signals: [
        observation().signals[1],
        { ...observation().signals[0], key: 'new-review', revision: 'new-feedback' },
      ],
    },
  });
  await dispatcher.reconcile();
  const second = getQueueSnapshot().find((item) => item.prWork?.sourceId === monitor.id)!;
  assert.notEqual(second.id, first.id);
  assert.deepEqual(second.prWork?.incidentIds, [check.id]);
  assert.equal(store.get(monitor.id, 'owner').repairs![0].mode, 'manual');
});

test('a repair completing during history reconciliation cannot authorize duplicate feedback work', async (t) => {
  const { store, monitor, dispatcher } = await fixture(t);
  const onlyReview = { ...observation(), signals: [observation().signals[0]] };
  await store.observe(monitor.id, 'owner', monitor.revision, { observation: onlyReview });
  const other = await store.subscribe('other-owner', config);
  await store.observe(other.id, 'other-owner', other.revision, { observation: onlyReview });
  await dispatcher.reconcile();
  const queued = getQueueSnapshot().find((item) => item.prWork?.sourceId === monitor.id)!;
  const run = createRun(
    { flowType: 'pr-complete', project: 'project', ticketOrPr: 'owner/repo#501' },
    { deferBackgroundPersist: true },
  );
  run.prWork = queued.prWork;
  await persistRunNow(run, 'repair-race-test');
  await dispatcher.created(queued, run);
  t.after(async () => {
    updateRun(run.id, { status: 'done' });
    await deleteRun(run.id);
  });
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 60_001 });
  const reconcileHistory = store.reconcileRepairHistory.bind(store);
  const hook = t.mock.method(store, 'reconcileRepairHistory', async () => {
    await reconcileHistory();
    updateRun(run.id, { status: 'done', completedAt: new Date().toISOString() });
    await persistRunNow(run, 'repair-race-test-done');
  });
  await dispatcher.reconcile();
  assert.equal(getQueueSnapshot().filter((item) => item.prWork?.sourceId === other.id).length, 0);
  assert.match(
    store.get(other.id, 'other-owner').repairs![0].waitingReason ?? '',
    /history reconciliation/,
  );
  hook.mock.restore();
  await dispatcher.reconcile();
  assert(store.get(other.id, 'other-owner').incidents[0].handledAt);
  assert.equal(getQueueSnapshot().filter((item) => item.prWork?.sourceId === other.id).length, 0);
});

test('stale subscriptions inherit repair history before a later provider refresh', async (t) => {
  const { store, monitor, dispatcher } = await fixture(t);
  const other = await store.subscribe('other-owner', config);
  await store.observe(other.id, 'other-owner', other.revision, { observation: observation() });
  await store.observe(other.id, 'other-owner', store.get(other.id, 'other-owner').revision, {
    error: 'Provider is temporarily unavailable',
    checkedAt: new Date().toISOString(),
  });
  await dispatcher.reconcile();
  const repair = store.get(monitor.id, 'owner').repairs![0];
  await store.updateRepair(
    monitor.id,
    'owner',
    repair.id,
    { state: 'finished', runId: 'history-run', completedAt: new Date().toISOString() },
    { countAttempt: true, handledFeedback: true, frozenIncidentIds: repair.incidentIds },
  );
  await store.reconcileRepairHistory();
  let refreshed = store.get(other.id, 'other-owner');
  assert(refreshed.incidents.every((incident) => incident.attemptCount === 1));
  assert(refreshed.incidents.find((incident) => incident.signal.kind === 'review')?.handledAt);
  await store.observe(other.id, 'other-owner', refreshed.revision, { observation: observation() });
  refreshed = store.get(other.id, 'other-owner');
  assert(refreshed.incidents.find((incident) => incident.signal.kind === 'review')?.handledAt);
});

test('transient post-persistence refusal clears queue linkage without recording operator cancellation', async (t) => {
  const { store, monitor, dispatcher } = await fixture(t);
  await dispatcher.reconcile();
  const queued = getQueueSnapshot().find((item) => item.prWork?.sourceId === monitor.id)!;
  const run = createRun(
    { flowType: 'pr-complete', project: 'project', ticketOrPr: 'owner/repo#501' },
    { deferBackgroundPersist: true },
  );
  run.prWork = { ...queued.prWork!, id: 'repair:other-history' };
  updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
  await persistRunNow(run, 'repair-transient-test');
  t.after(async () => {
    updateRun(run.id, { status: 'done' });
    await deleteRun(run.id);
  });
  let changed = false;
  const racing = new PRRepairDispatcher(
    store,
    { refresh: async () => store.get(monitor.id, 'owner') },
    () => true,
    () => {},
    async () => {
      if (!changed) {
        changed = true;
        updateRun(run.id, { status: 'done' });
      }
      return {
        choices: [{ slotId: 'repair-slot', runner: 'codex', model: 'gpt-6-astra', effort: 'high' }],
        errors: [],
      };
    },
  );
  await racing.reconcile();
  const suspended = store.get(monitor.id, 'owner').repairs![0];
  assert.equal(suspended.queueItemId, undefined);
  assert.equal(suspended.state, 'blocked');
  await racing.reconcile();
  const resumed = store.get(monitor.id, 'owner');
  assert.equal(resumed.repairs![0].state, 'queued');
  assert(resumed.incidents.every((incident) => !incident.resumeCondition));
});
