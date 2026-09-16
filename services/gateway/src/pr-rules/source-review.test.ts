import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test, type TestContext } from 'node:test';

import { prExecutionChoices, type PRReviewRequest, type PRRuleSubject } from '@farmslot/protocol';

const root = mkdtempSync(path.join(tmpdir(), 'qa-source-review-'));
for (const directory of ['scripts', 'services/gateway', 'pool', 'projects/farm', 'repo'])
  mkdirSync(path.join(root, directory), { recursive: true });
writeFileSync(path.join(root, 'CLAUDE.md'), '# Isolated handoff fixture\n');
writeFileSync(path.join(root, 'scripts/dev.sh'), '#!/bin/sh\n');
writeFileSync(path.join(root, 'services/gateway/package.json'), '{}');
const execution = {
  slotPolicy: { kind: 'exact' as const, slotId: 'runtime' },
  models: [{ runner: 'codex', model: 'gpt-6-astra', effort: 'high' }],
};
writeFileSync(
  path.join(root, 'projects/farm/project.json'),
  JSON.stringify({
    name: 'farm',
    ci: { repo: 'example/app' },
    workflow_defaults: { qa: { execution } },
    qa: {
      default_profile: 'changes',
      profiles: [{ id: 'changes', title: 'Changes', template_id: 'validation/shared' }],
    },
  }),
);
writeFileSync(
  path.join(root, 'pool/runtime.json'),
  JSON.stringify({
    machine: 'runtime-host',
    project: 'farm',
    host: 'localhost',
    platform: 'cli',
    slots: [
      {
        id: 'runtime',
        enabled: true,
        repo: path.join(root, 'repo'),
        session: 'fixture-runtime',
        resources: {},
      },
    ],
  }),
);
writeFileSync(
  path.join(root, '.farm-status.json'),
  JSON.stringify({
    checked_at: new Date().toISOString(),
    slots: [
      {
        slot: 'runtime',
        machine: 'runtime-host',
        project: 'farm',
        platform: 'cli',
        lifecycle: 'ready',
        agent: 'idle',
      },
    ],
  }),
);
Object.assign(process.env, {
  FARMSLOT_ROOT: root,
  FARMSLOT_HOME: path.join(root, 'home'),
  FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
  FARMSLOT_POOL_DIR: path.join(root, 'pool'),
  NODE_TEST_CONTEXT: '1',
  FARMSLOT_TEST_STATUS_FILE: path.join(root, '.farm-status.json'),
});
after(() => rmSync(root, { recursive: true, force: true }));
const { PRRuleService } = await import('./service.js');
const { PRRuleStore } = await import('./store.js');
const { PRReviewDispatcher } = await import('./dispatch.js');
const { validateQaSourceReview } = await import('./source-review.js');
const { createRun, deleteRun, archiveRun, getRun } = await import('../runs/store.js');
const { getQueueSnapshot, removeQueueItemInternalNow, updateItem } =
  await import('../backlog/dispatch-queue.js');
const HEAD = 'a'.repeat(40);
const pr = { host: 'github.com', repo: 'example/app', number: 42 };

function sourceRun(t: TestContext) {
  const run = createRun(
    {
      flowType: 'review-pr',
      project: 'farm',
      ticketOrPr: 'example/app#42',
      familyId: 'source-family',
    },
    { deferBackgroundPersist: true, createdByPrincipalId: 'owner' },
  );
  run.status = 'done';
  run.transport = 'native';
  run.nativeOwnerPrincipalId = 'owner';
  run.reviewResult = {
    recommendation: 'REQUEST_CHANGES',
    reviewMd: 'Verified static findings',
    lineComments: [],
    reviewSnapshot: { source: 'github-pr', headSha: HEAD, capturedAt: new Date().toISOString() },
  };
  run.reviewWorkspaceSubject = {
    repository: pr.repo,
    repositoryUrl: 'https://github.com/example/app.git',
    headSha: HEAD,
    baseSha: 'b'.repeat(40),
    branch: 'feature',
    title: 'PR',
    body: '',
    capturedAt: new Date().toISOString(),
  };
  t.after(() => deleteRun(run.id));
  return run;
}

async function fixture(t: TestContext) {
  const file = path.join(root, `rules-${Math.random()}.json`);
  const store = await PRRuleStore.load(file);
  let headSha = HEAD;
  let reads = 0;
  const collect = async () => {
    reads += 1;
    const subject: PRRuleSubject = {
      pr,
      headSha,
      title: 'PR',
      observedAt: new Date().toISOString(),
      facts: { state: { state: 'known', value: 'open' }, draft: { state: 'known', value: false } },
    };
    return { subjects: [subject], complete: true, errors: [], ignoredItems: 0 };
  };
  const service = new PRRuleService(
    store,
    () => true,
    () => {},
    collect,
    collect,
  );
  t.after(() => service.stop());
  const team = await service.saveTeam('owner', {
    name: 'Team',
    account: { host: 'github.com', login: 'reviewer' },
    sources: [{ kind: 'repository', repo: pr.repo }],
    predicate: { kind: 'compare', field: 'state', operator: 'equals', value: 'open' },
    repositories: [
      { repo: pr.repo, project: 'farm', reviewProfile: 'standard', excludedLabels: [] },
    ],
    githubTeams: [],
    notificationPrincipalIds: [],
  });
  t.after(async () => {
    const ids = new Set(store.snapshot().intents.map((intent) => intent.id));
    for (const item of getQueueSnapshot())
      if (ids.has(item.prWork?.sourceId ?? ''))
        await removeQueueItemInternalNow(item.id, 'handoff-test-cleanup');
  });
  const request: PRReviewRequest = {
    teamId: team.id,
    pr,
    idempotencyKey: 'linked',
    autoStart: true,
    review: { sessionIntent: 'reset', scope: 'full', workflow: 'qa' },
    source: { client: 'test' },
  };
  return {
    file,
    store,
    service,
    request,
    setHead: (value: string) => {
      headSha = value;
    },
    reads: () => reads,
  };
}

test('source validation rejects foreign, missing, wrong-target and unconfirmed reviews', async (t) => {
  const run = sourceRun(t);
  const input = { runId: run.id, ownerId: 'owner', project: 'farm', pr };
  assert.deepEqual(await validateQaSourceReview(input), { runId: run.id, headSha: HEAD });
  for (const patch of [
    { runId: 'missing' },
    { ownerId: 'other' },
    { project: 'other' },
    { pr: { ...pr, number: 43 } },
    { pr: { ...pr, repo: 'other/app' } },
    { observedHeadSha: 'b'.repeat(40) },
  ])
    await assert.rejects(() => validateQaSourceReview({ ...input, ...patch }));
  const original = structuredClone(run);
  for (const patch of [
    { status: 'failed' },
    { flowType: 'qa' },
    { reviewValidationDepth: 'full-live' },
    { reviewResult: undefined },
    { reviewResult: { ...original.reviewResult, reviewMd: '' } },
    {
      reviewResult: {
        ...original.reviewResult,
        reviewSnapshot: { ...original.reviewResult!.reviewSnapshot, headSha: 'b'.repeat(40) },
      },
    },
  ]) {
    Object.assign(run, patch);
    await assert.rejects(() => validateQaSourceReview(input));
    Object.assign(run, structuredClone(original));
  }
});

test('URL edits and stale provider heads cannot create linked QA work', async (t) => {
  const f = await fixture(t);
  const run = sourceRun(t);
  await assert.rejects(
    f.service.submit('owner', {
      ...f.request,
      sourceReviewRunId: run.id,
      pr: { ...pr, number: 43 },
    }),
    /another PR/,
  );
  assert.equal(f.reads(), 0);
  assert.equal(f.store.snapshot().submissions?.length ?? 0, 0);
  f.setHead('b'.repeat(40));
  const receipt = await f.service.submit('owner', { ...f.request, sourceReviewRunId: run.id });
  assert.deepEqual(receipt.sourceReview, { runId: run.id, headSha: HEAD });
  const failed = await f.service.refreshSubmission('owner', receipt.id);
  assert.match(failed.error ?? '', /PR head changed/);
  assert.equal(failed.intentId, undefined);
  assert.equal(f.store.snapshot().intents.length, 0);
});

test('linked QA deduplicates within its source and persists apart from unlinked QA and other source reviews', async (t) => {
  const f = await fixture(t);
  const first = sourceRun(t);
  const second = sourceRun(t);
  async function submit(idempotencyKey: string, sourceReviewRunId?: string) {
    const receipt = await f.service.submit('owner', {
      ...f.request,
      idempotencyKey,
      sourceReviewRunId,
    });
    return f.service.refreshSubmission('owner', receipt.id);
  }
  const linked = await submit('one', first.id);
  const duplicate = await submit('two', first.id);
  const standalone = await submit('standalone');
  const another = await submit('other', second.id);
  assert.equal(linked.intentId, duplicate.intentId);
  assert.equal(new Set([linked.intentId, standalone.intentId, another.intentId]).size, 3);
  const reloaded = await PRRuleStore.load(f.file);
  assert.deepEqual(reloaded.submission(linked.id, 'owner').sourceReview, {
    runId: first.id,
    headSha: HEAD,
  });
  assert.deepEqual(
    reloaded.intent(linked.intentId!)?.contributions[0].sourceReview,
    linked.sourceReview,
  );
  const disk = readFileSync(f.file, 'utf8');
  const corrupt = JSON.parse(disk);
  delete corrupt.submissions[0].sourceReview;
  writeFileSync(f.file, JSON.stringify(corrupt));
  await assert.rejects(PRRuleStore.load(f.file), /source review provenance/);
  writeFileSync(f.file, disk);
});

test('queued QA links its source family without inheriting native transport and rechecks the source before creation', async (t) => {
  const f = await fixture(t);
  const run = sourceRun(t);
  const receipt = await f.service.submit('owner', { ...f.request, sourceReviewRunId: run.id });
  const ready = await f.service.refreshSubmission('owner', receipt.id);
  const dispatcher = new PRReviewDispatcher(
    f.store,
    f.service,
    () => true,
    () => {},
    async (_project, _repo, profiles) => ({ choices: prExecutionChoices(profiles[0]), errors: [] }),
  );
  await dispatcher.reconcile();
  const queued = getQueueSnapshot().find((item) => item.prWork?.sourceId === ready.intentId)!;
  assert.equal(queued.parentRunId, run.id);
  assert.equal(queued.familyId, run.familyId);
  assert.equal(queued.transport, 'tmux');
  const selected = { ...queued, slotId: 'runtime' };
  await dispatcher.refreshBeforeCreate(selected);
  assert.doesNotThrow(() => dispatcher.assertCurrent(selected));
  assert.equal((await dispatcher.prepare({ ...selected, parentRunId: 'other' })).ready, false);
  updateItem({ itemId: queued.id, priority: 1 }, { kind: 'principal', principalId: 'other' });
  assert.throws(() => dispatcher.assertCurrent(selected), /retain the source review owner/);
  updateItem({ itemId: queued.id, priority: 1 }, { kind: 'principal', principalId: 'owner' });
  run.reviewResult!.reviewSnapshot!.headSha = 'b'.repeat(40);
  run.reviewWorkspaceSubject!.headSha = 'b'.repeat(40);
  assert.throws(() => dispatcher.assertCurrent(selected), /Source review changed/);
  await dispatcher.reconcile();
  assert.equal(f.store.intent(ready.intentId!)?.status, 'needs-configuration');
  assert(!getQueueSnapshot().some((item) => item.id === queued.id));
});

test('an identical receipt retry remains readable after its source is removed', async (t) => {
  const f = await fixture(t);
  const run = sourceRun(t);
  const request = { ...f.request, sourceReviewRunId: run.id };
  const original = await f.service.submit('owner', request);
  const linked = await f.service.refreshSubmission('owner', original.id);
  await f.store.updateDispatch(linked.intentId!, {
    status: 'running',
    runId: 'already-started-qa',
  });
  await deleteRun(run.id);
  const retried = await f.service.submit('owner', request);
  assert.equal(retried.id, original.id);
  assert.deepEqual(retried.sourceReview, original.sourceReview);
  await assert.rejects(
    f.service.submit('owner', { ...request, idempotencyKey: 'new-request' }),
    /Source review is unavailable/,
  );
});

test('archived source reviews remain valid through linked QA queue admission', async (t) => {
  const f = await fixture(t);
  const run = sourceRun(t);
  await archiveRun(run.id);
  assert.equal(getRun(run.id), undefined);
  const receipt = await f.service.submit('owner', { ...f.request, sourceReviewRunId: run.id });
  const ready = await f.service.refreshSubmission('owner', receipt.id);
  const dispatcher = new PRReviewDispatcher(
    f.store,
    f.service,
    () => true,
    () => {},
    async (_project, _repo, profiles) => ({ choices: prExecutionChoices(profiles[0]), errors: [] }),
  );
  await dispatcher.reconcile();
  const queued = getQueueSnapshot().find((item) => item.prWork?.sourceId === ready.intentId)!;
  assert.equal(queued.parentRunId, run.id);
  assert.equal(queued.familyId, run.familyId);
  const selected = { ...queued, slotId: 'runtime' };
  await dispatcher.refreshBeforeCreate(selected);
  assert.doesNotThrow(() => dispatcher.assertCurrent(selected));
  f.setHead('b'.repeat(40));
  await assert.rejects(dispatcher.refreshBeforeCreate(selected), /PR head changed/);
  assert.equal(getRun(run.id), undefined);
});
