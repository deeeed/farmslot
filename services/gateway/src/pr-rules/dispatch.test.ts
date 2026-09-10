import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { PRExecutionProfile, PRRulePreview } from '@farmslot/protocol';

import { getQueueSnapshot, removeQueueItemInternalNow } from '../backlog/dispatch-queue.js';
import { createRun, deleteRun, persistRunNow, updateRun } from '../runs/store.js';

import { PRReviewDispatcher } from './dispatch.js';
import { PRRuleService } from './service.js';
import { PRRuleStore } from './store.js';

const execution: PRExecutionProfile = {
  slotPolicy: { kind: 'exact', slotId: 'test-slot' },
  models: [{ runner: 'codex', model: 'gpt-6-astra', effort: 'high' }],
};

let prNumber = 100;

async function fixture(t: test.TestContext, profile: PRExecutionProfile = execution) {
  const dir = await mkdtemp(join(tmpdir(), 'pr-review-dispatch-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'rules.json');
  const store = await PRRuleStore.load(file);
  const predicate = {
    kind: 'compare' as const,
    field: 'state' as const,
    operator: 'equals' as const,
    value: 'open',
  };
  const team = await store.saveTeam('owner', {
    name: 'Team',
    account: { host: 'github.com', login: 'reader' },
    sources: [{ kind: 'repository', repo: 'owner/repo' }],
    predicate,
    repositories: [
      { repo: 'owner/repo', project: 'project', reviewProfile: 'standard', excludedLabels: [] },
    ],
    execution: profile,
    githubTeams: [],
    notificationPrincipalIds: [],
  });
  let rule = await store.saveRule('owner', {
    name: 'Review',
    teamId: team.id,
    predicate,
    actions: [{ kind: 'review', autoStart: true }],
    pollIntervalMs: 300_000,
    maxAdmissionsPerScan: 1,
    rereviewOnHeadChange: true,
  });
  rule = await store.setEnabled('owner', rule.id, rule.revision, true, true);
  const number = ++prNumber;
  const preview: PRRulePreview = {
    teamId: team.id,
    teamRevision: team.revision,
    ruleId: rule.id,
    ruleRevision: rule.revision,
    checkedAt: new Date().toISOString(),
    complete: true,
    ignoredItems: 0,
    sourceErrors: [],
    items: [
      {
        subject: {
          pr: { host: 'github.com', repo: 'owner/repo', number },
          headSha: 'head-a',
          title: 'PR',
          observedAt: new Date().toISOString(),
          facts: {
            state: { state: 'known', value: 'open' },
            draft: { state: 'known', value: false },
          },
        },
        match: { state: 'match', reasons: ['Matched'] },
        project: 'project',
        reviewProfile: 'standard',
        execution: profile,
        configurationErrors: [],
      },
    ],
  };
  await store.applyPreview('owner', preview);
  const intent = store.snapshot().intents[0];
  t.after(async () => {
    for (const item of getQueueSnapshot().filter((entry) => entry.prWork?.sourceId === intent.id))
      await removeQueueItemInternalNow(item.id, 'test-cleanup');
  });
  const dispatcher = (current: PRRuleStore) =>
    new PRReviewDispatcher(
      current,
      new PRRuleService(
        current,
        () => true,
        () => {},
      ),
      () => true,
      () => {},
      async () => ({
        choices: [{ slotId: 'test-slot', runner: 'codex', model: 'gpt-6-astra', effort: 'high' }],
        errors: [],
      }),
    );
  return {
    file,
    store,
    intent,
    team,
    rule,
    preview,
    dispatcher: dispatcher(store),
    restart: async () => {
      const next = await PRRuleStore.load(file);
      return { store: next, dispatcher: dispatcher(next) };
    },
  };
}

test('review admission reuses one durable queue entry across concurrent ticks and restart', async (t) => {
  const { store, intent, dispatcher, restart } = await fixture(t);
  await Promise.all([dispatcher.reconcile(), dispatcher.reconcile()]);
  const queued = getQueueSnapshot().filter((item) => item.prWork?.sourceId === intent.id);
  assert.equal(queued.length, 1);
  assert.equal(store.intent(intent.id)?.queueItemId, queued[0].id);
  assert.equal(queued[0].model, 'gpt-6-astra');
  assert.equal(queued[0].prWork?.review?.options.sessionIntent, 'resume');
  const next = await restart();
  await next.dispatcher.reconcile();
  assert.equal(getQueueSnapshot().filter((item) => item.prWork?.sourceId === intent.id).length, 1);
  assert.equal(next.store.intent(intent.id)?.queueItemId, queued[0].id);
});

test('review settings survive queue restart and edits replace unstarted instructions', async (t) => {
  const { store, intent, dispatcher, preview, restart } = await fixture(t);
  await dispatcher.reconcile();
  const first = getQueueSnapshot().find((item) => item.prWork?.sourceId === intent.id)!;
  preview.items[0].review = { sessionIntent: 'reset', scope: 'full', validationDepth: 'full-live' };
  await store.applyPreview('owner', preview);
  await dispatcher.reconcile();
  const current = getQueueSnapshot().find((item) => item.prWork?.sourceId === intent.id)!;
  assert.notEqual(first.id, current.id);
  assert.equal(current.reviewValidationDepth, 'full-live');
  assert.deepEqual(current.prWork?.review?.options, preview.items[0].review);
  assert.equal((await dispatcher.prepare(first)).ready, false);
  const next = await restart();
  await next.dispatcher.reconcile();
  assert.deepEqual(next.store.intent(intent.id)?.contributions[0].review, preview.items[0].review);
  assert.equal(
    getQueueSnapshot().find((item) => item.prWork?.sourceId === intent.id)?.id,
    current.id,
  );
});

test('removing an unstarted automatic review holds it instead of silently requeueing', async (t) => {
  const { store, intent, dispatcher } = await fixture(t);
  await dispatcher.reconcile();
  await removeQueueItemInternalNow(store.intent(intent.id)!.queueItemId!, 'operator-remove');
  await dispatcher.reconcile();
  await dispatcher.reconcile();
  assert.match(store.intent(intent.id)?.dispatchHold ?? '', /removed/);
  assert.equal(getQueueSnapshot().filter((item) => item.prWork?.sourceId === intent.id).length, 0);
});

test('a durable run created before the source link is recovered without another queue or run', async (t) => {
  const { intent, dispatcher, restart } = await fixture(t);
  await dispatcher.reconcile();
  const queued = getQueueSnapshot().find((item) => item.prWork?.sourceId === intent.id)!;
  const run = createRun(
    { flowType: 'review-pr', project: 'project', ticketOrPr: `owner/repo#${intent.pr.number}` },
    { deferBackgroundPersist: true },
  );
  run.prWork = queued.prWork;
  await persistRunNow(run, 'pr-admission-test');
  t.after(async () => {
    updateRun(run.id, { status: 'done' });
    await deleteRun(run.id);
  });
  const next = await restart();
  await next.dispatcher.reconcile();
  assert.equal(next.store.intent(intent.id)?.runId, run.id);
  assert.equal(next.store.intent(intent.id)?.status, 'running');
  assert.equal(getQueueSnapshot().filter((item) => item.prWork?.sourceId === intent.id).length, 0);
});

test('completed artifact-only review reconciles from recorded evidence across restart', async (t) => {
  const { intent, dispatcher, restart } = await fixture(t);
  await dispatcher.reconcile();
  const queued = getQueueSnapshot().find((item) => item.prWork?.sourceId === intent.id)!;
  const run = createRun(
    {
      flowType: 'review-pr',
      project: 'project',
      ticketOrPr: `owner/repo#${intent.pr.number}`,
      completionPolicy: 'artifact-only',
    },
    { deferBackgroundPersist: true },
  );
  run.prWork = queued.prWork;
  run.status = 'done';
  run.reviewResult = {
    reviewMd: 'Review completed',
    recommendation: 'REQUEST_CHANGES',
    lineComments: [],
    reviewSnapshot: {
      source: 'github-pr',
      headSha: 'actual-reviewed-head',
      capturedAt: new Date().toISOString(),
    },
  };
  await persistRunNow(run, 'completed-review-test');
  t.after(() => deleteRun(run.id));
  const next = await restart();
  await next.dispatcher.reconcile();
  assert.equal(next.store.intent(intent.id)?.status, 'completed');
  assert.equal(next.store.intent(intent.id)?.reviewedSha, 'actual-reviewed-head');
  assert.notEqual(next.store.intent(intent.id)?.reviewedSha, run.prWork?.headSha);
  assert.equal(run.decisions.length, 0);
  updateRun(run.id, { reviewResult: undefined });
  await next.dispatcher.reconcile();
  assert.equal(
    next.store.intent(intent.id)?.status,
    'failed',
    'Requested head alone cannot prove a completed review',
  );
});

test('narrower constraints arriving during model resolution cannot be certified with stale choices', async (t) => {
  const pool: PRExecutionProfile = {
    ...execution,
    slotPolicy: { kind: 'pool', allowedSlots: ['test-slot', 'other-slot'] },
  };
  const { store, intent, dispatcher, rule, preview } = await fixture(t, pool);
  await dispatcher.reconcile();
  const queued = getQueueSnapshot().find((item) => item.prWork?.sourceId === intent.id)!;
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const racing = new PRReviewDispatcher(
    store,
    {
      refreshTarget: async () => preview,
      refreshSubmission: async () => {
        throw new Error('Unexpected submission');
      },
    },
    () => true,
    () => {},
    async () => {
      entered();
      await gate;
      return {
        choices: [{ slotId: 'test-slot', runner: 'codex', model: 'gpt-6-astra', effort: 'high' }],
        errors: [],
      };
    },
  );
  const selected = { ...queued, slotId: 'test-slot' };
  const pending = racing.refreshBeforeCreate(selected);
  await started;
  let second = await store.saveRule('owner', { ...rule.config, name: 'Narrower review' });
  second = await store.setEnabled('owner', second.id, second.revision, true, true);
  await store.applyPreview('owner', {
    ...preview,
    ruleId: second.id,
    ruleRevision: second.revision,
    items: preview.items.map((item) => ({
      ...item,
      execution: { ...execution, slotPolicy: { kind: 'exact', slotId: 'other-slot' } },
    })),
  });
  assert.equal(store.intent(intent.id)?.status, 'queued');
  release();
  await assert.rejects(pending, /constraints changed/);
  assert.throws(() => racing.assertCurrent(selected), /admission changed/);
});

test('project remapping replaces unstarted queue rows while retaining the durable work identity', async (t) => {
  const { store, intent, dispatcher, team, preview } = await fixture(t);
  await dispatcher.reconcile();
  const original = getQueueSnapshot().find((item) => item.prWork?.sourceId === intent.id)!;
  const updated = await store.saveTeam(
    'owner',
    {
      ...team.config,
      repositories: team.config.repositories.map((item) => ({ ...item, project: 'new-project' })),
    },
    team.id,
    team.revision,
  );
  await store.applyPreview('owner', {
    ...preview,
    teamRevision: updated.revision,
    items: preview.items.map((item) => ({ ...item, project: 'new-project' })),
  });
  await dispatcher.reconcile();
  const queued = getQueueSnapshot().filter((item) => item.prWork?.sourceId === intent.id);
  assert.equal(queued.length, 1);
  assert.notEqual(queued[0].id, original.id);
  assert.equal(queued[0].prWork?.id, original.prWork?.id);
  assert.equal(queued[0].project, 'new-project');
});

test('restart during remapping recovers the replacement instead of treating it as operator removal', async (t) => {
  const { store, intent, dispatcher, team, preview, restart } = await fixture(t);
  await dispatcher.reconcile();
  const old = getQueueSnapshot().find((item) => item.prWork?.sourceId === intent.id)!;
  const updated = await store.saveTeam(
    'owner',
    {
      ...team.config,
      repositories: team.config.repositories.map((item) => ({ ...item, project: 'new-project' })),
    },
    team.id,
    team.revision,
  );
  await store.applyPreview('owner', {
    ...preview,
    teamRevision: updated.revision,
    items: preview.items.map((item) => ({ ...item, project: 'new-project' })),
  });
  // Durable boundary used by remapping: source link clears before the obsolete row is removed.
  await store.updateDispatch(intent.id, { queueItemId: undefined, status: 'held' });
  await removeQueueItemInternalNow(old.id, 'pr-review-remapped');
  const recovered = await restart();
  await recovered.dispatcher.reconcile();
  assert.equal(recovered.store.intent(intent.id)?.dispatchHold, undefined);
  const rows = getQueueSnapshot().filter((item) => item.prWork?.sourceId === intent.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].project, 'new-project');
});
