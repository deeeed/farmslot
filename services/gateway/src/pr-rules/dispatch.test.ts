import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  intersectPRExecutionProfiles,
  type PRExecutionProfile,
  type PRRulePreview,
  type PRWorkspaceExecutionProfile,
  resolveReviewQaDispatch,
} from '@farmslot/protocol';

import { getQueueSnapshot, removeQueueItemInternalNow } from '../backlog/dispatch-queue.js';
import { migrateQueuedReviewQa } from '../backlog/review-qa-migration.js';
import { createRun, deleteRun, persistRunNow, updateRun } from '../runs/store.js';

import { PRReviewDispatcher } from './dispatch.js';
import { resolvePreviewQaPreset } from './qa-preset.js';
import { PRRuleService } from './service.js';
import { PRRuleStore } from './store.js';

const execution: PRWorkspaceExecutionProfile = {
  workspacePolicy: { kind: 'exact', machine: 'test-machine' },
  transport: 'native',
  models: [{ runner: 'codex', model: 'gpt-6-astra', effort: 'high' }],
};

let prNumber = 100;

async function fixture(t: test.TestContext, profile: PRExecutionProfile = execution) {
  const nativeOwner = process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID;
  process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = 'owner';
  t.after(() => {
    if (nativeOwner === undefined) delete process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID;
    else process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = nativeOwner;
  });
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
    const ids = new Set(store.snapshot().intents.map((entry) => entry.id));
    for (const item of getQueueSnapshot().filter((entry) => ids.has(entry.prWork?.sourceId ?? '')))
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
      async (_project, _repo, profiles) => ({
        choices: intersectPRExecutionProfiles(profiles),
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

test('incremental intake retains the owned predecessor domain for skill and template selection', async (t) => {
  const { intent, dispatcher } = await fixture(t);
  for (const [owner, domain] of [
    ['owner', 'perps'],
    ['other-owner', 'unrelated'],
  ]) {
    const prior = createRun(
      {
        flowType: 'review-pr',
        project: 'project',
        ticketOrPr: `owner/repo#${intent.pr.number}`,
        domain,
      },
      { deferBackgroundPersist: true },
    );
    prior.status = 'done';
    prior.createdByPrincipalId = owner;
    prior.reviewResult = {
      reviewMd: 'Prior review',
      recommendation: 'COMMENT',
      lineComments: [],
      reviewSnapshot: {
        headSha: 'a'.repeat(40),
        source: 'github-pr',
        capturedAt: new Date().toISOString(),
      },
    };
    await persistRunNow(prior, 'domain-continuity-test');
    t.after(() => deleteRun(prior.id));
  }
  await dispatcher.reconcile();
  assert.equal(
    getQueueSnapshot().find((item) => item.prWork?.sourceId === intent.id)?.domain,
    'perps',
  );
});

test('changing static review to QA creates distinct work that survives restart', async (t) => {
  const { store, intent, dispatcher, preview, restart } = await fixture(t);
  await dispatcher.reconcile();
  const first = getQueueSnapshot().find((item) => item.prWork?.sourceId === intent.id)!;
  preview.items[0].review = {
    sessionIntent: 'reset',
    scope: 'full',
    workflow: 'qa',
    qaProfileId: 'changes',
    qaInputs: { scope: 'pr' },
  };
  preview.items[0].execution = {
    slotPolicy: { kind: 'exact', slotId: 'test-slot' },
    models: execution.models,
  };
  await store.applyPreview('owner', preview);
  await dispatcher.reconcile();
  const current = getQueueSnapshot().find((item) => item.flowType === 'qa')!;
  assert.notEqual(first.id, current.id);
  assert.notEqual(current.prWork?.sourceId, intent.id);
  assert.equal(current.reviewValidationDepth, undefined);
  assert.equal(current.qaProfileId, 'changes');
  assert.deepEqual(current.qaInputs, { scope: 'pr' });
  assert.match(current.initialContext ?? '', /runtime evidence/);
  assert.equal((await dispatcher.prepare({ ...current, qaProfileId: 'different' })).ready, false);
  assert.equal((await dispatcher.prepare({ ...current, flowType: 'review-pr' })).ready, false);
  assert.deepEqual(current.prWork?.review?.options, preview.items[0].review);
  assert.equal((await dispatcher.prepare(first)).ready, false);
  const next = await restart();
  await next.dispatcher.reconcile();
  assert.deepEqual(
    next.store.intent(current.prWork!.sourceId)?.contributions[0].review,
    preview.items[0].review,
  );
  assert.equal(
    getQueueSnapshot().find((item) => item.prWork?.sourceId === current.prWork?.sourceId)?.id,
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

test('QA completion uses the verified runtime receipt and cannot inherit static review evidence', async (t) => {
  for (const receipt of ['missing', 'wrong-head', 'empty', 'invalid-digest', 'valid']) {
    const valid = receipt === 'valid';
    const { store, dispatcher, preview, restart } = await fixture(t);
    preview.items[0].review = {
      sessionIntent: 'resume',
      scope: 'full',
      workflow: 'qa',
      qaProfileId: 'changes',
    };
    preview.items[0].execution = {
      slotPolicy: { kind: 'exact', slotId: 'test-slot' },
      models: execution.models,
    };
    await store.applyPreview('owner', preview);
    await dispatcher.reconcile();
    const intent = store
      .snapshot()
      .intents.find((item) =>
        item.contributions.some((source) => source.eligible && source.review?.workflow === 'qa'),
      )!;
    const queued = getQueueSnapshot().find((item) => item.prWork?.sourceId === intent.id)!;
    const qa = resolveReviewQaDispatch(
      { flowType: 'qa', qaProfileId: 'changes' },
      {
        default_profile: 'changes',
        profiles: [{ id: 'changes', title: 'Changes', template_id: 'validation/shared' }],
      },
    );
    const run = createRun(
      {
        flowType: 'qa',
        project: 'project',
        ticketOrPr: `owner/repo#${intent.pr.number}`,
        slotId: 'test-slot',
      },
      { deferBackgroundPersist: true, reviewQa: qa },
    );
    run.prWork = queued.prWork;
    run.status = 'done';
    run.reviewResult = {
      reviewMd: 'Static report',
      recommendation: 'APPROVE',
      lineComments: [],
      reviewSnapshot: {
        headSha: intent.headSha,
        source: 'github-pr',
        capturedAt: new Date().toISOString(),
      },
    };
    if (receipt !== 'missing')
      run.steps.find((step) => step.name === 'monitor')!.outputs = {
        qaEvidence: {
          headSha: receipt === 'wrong-head' ? 'other-head' : intent.headSha,
          packages:
            receipt === 'empty'
              ? []
              : [
                  {
                    path: 'suite/smoke',
                    digest: receipt === 'invalid-digest' ? 'invalid' : `sha256:${'a'.repeat(64)}`,
                  },
                ],
        },
      };
    run.steps.find((step) => step.name === 'monitor')!.status = 'done';
    await persistRunNow(run, 'qa-completion-test');
    t.after(() => deleteRun(run.id));
    const restored = await restart();
    await restored.dispatcher.reconcile();
    assert.equal(restored.store.intent(intent.id)?.status, valid ? 'completed' : 'failed', receipt);
    assert.equal(restored.store.intent(intent.id)?.reviewedSha, valid ? intent.headSha : undefined);
  }
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
    workspacePolicy: { kind: 'pool', allowedMachines: ['test-machine', 'other-machine'] },
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
        choices: [
          {
            machine: 'test-machine',
            transport: 'native' as const,
            runner: 'codex',
            model: 'gpt-6-astra',
            effort: 'high',
          },
        ],
        errors: [],
      };
    },
  );
  const selected = { ...queued, reviewWorkspaceTarget: { machine: 'test-machine' } };
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
      execution: { ...execution, workspacePolicy: { kind: 'exact', machine: 'other-machine' } },
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

test('GitHub approval and an existing review on this head remove queued duplicate reviews', async (t) => {
  const { store, intent, dispatcher, preview, file } = await fixture(t);
  await dispatcher.reconcile();
  assert(getQueueSnapshot().some((item) => item.prWork?.sourceId === intent.id));
  const observation = {
    observedAt: new Date().toISOString(),
    headSha: 'head-a',
    state: 'open' as const,
    draft: false,
    decision: 'REVIEW_REQUIRED',
    reviewer: 'reader',
    requested: false,
    review: { state: 'APPROVED', commit: 'head-a', submittedAt: null },
  };
  preview.items[0].subject.reviewObservation = observation;
  await store.applyPreview('owner', preview);
  await dispatcher.reconcile();
  assert(!getQueueSnapshot().some((item) => item.prWork?.sourceId === intent.id));
  assert.match(store.intent(intent.id)?.waitingReason ?? '', /Review is not needed/);
  assert(!store.intent(intent.id)?.waitingReason?.includes('reader'));
  const restarted = await PRRuleStore.load(file);
  assert.equal(
    restarted.intent(intent.id)?.contributions[0].reviewObservation?.review?.commit,
    'head-a',
  );
  observation.requested = true;
  await store.applyPreview('owner', preview);
  await dispatcher.reconcile();
  assert(getQueueSnapshot().some((item) => item.prWork?.sourceId === intent.id));
  observation.requested = false;
  observation.decision = 'APPROVED';
  await store.applyPreview('owner', preview);
  await dispatcher.reconcile();
  assert(!getQueueSnapshot().some((item) => item.prWork?.sourceId === intent.id));
  assert.match(store.intent(intent.id)?.waitingReason ?? '', /Review is not needed/);
});

test('publication selection and account are frozen into queue admission and cannot be substituted', async (t) => {
  const { store, intent, dispatcher, preview } = await fixture(t);
  preview.items[0].review = {
    sessionIntent: 'reset',
    scope: 'full',
    workflow: 'review',
    publishReview: true,
  };
  preview.items[0].policySources = { execution: 'rule', review: 'rule', publication: 'rule' };
  await store.applyPreview('owner', preview);
  await dispatcher.reconcile();
  const queued = getQueueSnapshot().find((item) => item.prWork?.sourceId === intent.id)!;
  assert.equal(queued.prWork?.publication?.enabled, true);
  assert.equal(queued.prWork?.publication?.source, 'rule');
  assert.equal(queued.prWork?.publication?.teamId, preview.teamId);
  assert.deepEqual(
    queued.prWork?.publication?.account,
    store.team(preview.teamId, 'owner').config.account,
  );
  const substituted = {
    ...queued,
    prWork: {
      ...queued.prWork!,
      publication: {
        ...queued.prWork!.publication!,
        account: { host: 'github.com', login: 'other' },
      },
    },
  };
  const result = await dispatcher.prepare(substituted);
  assert.equal(result.ready, false);
  if (!result.ready) assert.match(result.reason, /publication policy or account changed/);
});

test('farm QA inputs stay identical through PR preview, queue migration and admission', async (t) => {
  const { store, dispatcher, preview } = await fixture(t);
  const qa = {
    default_profile: 'pr',
    profiles: [
      { id: 'pr', title: 'PR QA', template_id: 'validation/shared', inputs: { scope: 'pr' } },
    ],
  };
  const workflowDefaults = {
    qa: {
      review: {
        workflow: 'qa' as const,
        sessionIntent: 'reset' as const,
        scope: 'full' as const,
        qaInputs: { domain: 'payments', chain: 'default' },
      },
    },
  };
  preview.items[0].review = {
    workflow: 'qa',
    sessionIntent: 'reset',
    scope: 'full',
    qaInputs: { chain: 'requested' },
  };
  preview.items[0].execution = {
    slotPolicy: { kind: 'exact', slotId: 'test-slot' },
    models: execution.models,
  };
  resolvePreviewQaPreset(preview.items[0], qa, workflowDefaults);
  await store.applyPreview('owner', preview);
  await dispatcher.reconcile();
  const queued = getQueueSnapshot().find(
    (item) =>
      item.prWork?.sourceId ===
      store
        .snapshot()
        .intents.find((item) =>
          item.contributions.some((source) => source.review?.workflow === 'qa'),
        )?.id,
  )!;
  assert(queued);
  migrateQueuedReviewQa(queued, qa, workflowDefaults);
  assert.deepEqual(queued.qaInputs, { scope: 'pr', domain: 'payments', chain: 'requested' });
  assert.deepEqual(queued.qaInputs, queued.prWork?.review?.options.qaInputs);
  const prepared = await dispatcher.prepare(queued);
  assert.equal(prepared.ready, true, JSON.stringify(prepared));
  await dispatcher.reconcile();
  assert.equal(
    getQueueSnapshot().find((item) => item.prWork?.sourceId === queued.prWork?.sourceId)?.id,
    queued.id,
  );
});
