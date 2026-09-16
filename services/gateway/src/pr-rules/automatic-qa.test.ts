import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test, type TestContext } from 'node:test';

import {
  captureQaAfterReview,
  type Principal,
  type PRRuleSubject,
  type Run,
} from '@farmslot/protocol';

const root = mkdtempSync(path.join(tmpdir(), 'automatic-qa-'));
for (const directory of [
  'scripts',
  'services/gateway',
  'pool',
  'projects/farm/shared/review-pr',
  'repo',
  'bin',
])
  mkdirSync(path.join(root, directory), { recursive: true });
writeFileSync(path.join(root, 'CLAUDE.md'), '# Isolated automatic QA fixture\n');
writeFileSync(path.join(root, 'scripts/dev.sh'), '#!/bin/sh\n');
writeFileSync(path.join(root, 'services/gateway/package.json'), '{}');
writeFileSync(
  path.join(root, 'projects/farm/shared/review-pr/default.md'),
  '---\nplatforms: [cli]\nrunMode: autonomous\n---\n\n- [ ] Review the source.\n',
);
writeFileSync(
  path.join(root, 'bin/codex'),
  '#!/bin/sh\n[ "$1" = "--version" ] || exit 91\nprintf "codex-cli 0.154.0\\n"\n',
  { mode: 0o700 },
);
writeFileSync(
  path.join(root, 'bin/gh'),
  String.raw`#!/usr/bin/env node
const args=process.argv.slice(2);
if(args[0]!=='api'||args.some(arg=>['POST','PATCH','PUT','DELETE'].includes(arg))) throw new Error('Fixture refuses non-read GitHub commands');
if(args.includes('--include')) process.stdout.write('HTTP/2.0 200 OK\r\ncontent-type: application/json\r\n\r\n');
process.stdout.write(JSON.stringify({number:42,title:'Fixture',body:'',state:'open',labels:[],user:{login:'fixture'}}));
`,
  { mode: 0o700 },
);
const execution = {
  slotPolicy: { kind: 'exact' as const, slotId: 'runtime' },
  models: [{ runner: 'codex', model: 'gpt-6-luna', effort: 'low' }],
};
const defaults = {
  execution,
  review: {
    workflow: 'qa' as const,
    sessionIntent: 'reset' as const,
    scope: 'full' as const,
    qaInputs: { environment: 'staging' },
  },
};
const qa = {
  default_profile: 'pr',
  profiles: [
    { id: 'pr', title: 'PR validation', template_id: 'validation/shared', inputs: { scope: 'pr' } },
    {
      id: 'release',
      title: 'Release validation',
      template_id: 'validation/shared',
      inputs: { scope: 'release' },
    },
  ],
  after_review: { enabled: true, profile_id: 'pr' },
};
const config = {
  name: 'farm',
  repo_url: 'https://github.com/example/app.git',
  ci: { repo: 'example/app' },
  static_review: { template_id: 'review-pr/default' },
  execution_templates: {
    sources: [{ id: 'workspace:shared', kind: 'workspace', root: { projectPath: 'shared' } }],
  },
  qa,
  workflow_defaults: { qa: defaults },
};
const projectPath = path.join(root, 'projects/farm/project.json');
const writeConfig = (value = config) => writeFileSync(projectPath, JSON.stringify(value));
writeConfig();
writeFileSync(
  path.join(root, 'pool/review.json'),
  JSON.stringify({
    machine: 'review-node',
    host: 'localhost',
    project: 'farm',
    platform: 'cli',
    review_workspaces: { max_concurrent: 2 },
    slots: [],
  }),
);
writeFileSync(
  path.join(root, 'pool/runtime.json'),
  JSON.stringify({
    machine: 'runtime-host',
    host: 'localhost',
    project: 'farm',
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
  FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
  NODE_TEST_CONTEXT: '1',
  FARMSLOT_TEST_STATUS_FILE: path.join(root, '.farm-status.json'),
  FARMSLOT_DISABLE_RUN_ENGINE_START: '1',
  FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID: 'owner',
  FARMSLOT_DISPATCH_PRESSURE_ADMISSION: 'off',
  PATH: `${path.join(root, 'bin')}${path.delimiter}${process.env.PATH}`,
});
after(() => rmSync(root, { recursive: true, force: true }));
const { PRRuleStore } = await import('./store.js');
const { PRRuleService } = await import('./service.js');
const { automaticQaKey } = await import('./automatic-qa.js');
const {
  createRun,
  deleteRun,
  getRun,
  getRunWithArchived,
  archiveRun,
  updateQaFollowUp,
  updateRun,
  persistRunNow,
} = await import('../runs/store.js');
const { runCreate } = await import('../methods/run.js');
const { runWithSessionOriginator } = await import('../security/work-originator.js');
const HEAD = 'a'.repeat(40);
const pr = { host: 'github.com', repo: 'example/app', number: 42 };

function source(t: TestContext, enabled = true): Run {
  const run = createRun(
    { flowType: 'review-pr', project: 'farm', ticketOrPr: 'example/app#42' },
    {
      createdByPrincipalId: 'owner',
      deferBackgroundPersist: true,
      qaAfterReview: enabled ? captureQaAfterReview(qa, defaults) : undefined,
    },
  );
  run.status = 'done';
  run.reviewResult = {
    recommendation: 'APPROVE',
    reviewMd: 'Reviewed',
    lineComments: [],
    reviewSnapshot: { source: 'github-pr', headSha: HEAD, capturedAt: new Date().toISOString() },
  };
  t.after(() => deleteRun(run.id));
  return run;
}

async function fixture(t: TestContext) {
  writeConfig();
  t.after(() => writeConfig());
  const file = path.join(root, `rules-${Math.random()}.json`);
  let authorized = true;
  let head = HEAD;
  let reads = 0;
  let onRead: (() => void) | undefined;
  const collect = async () => {
    reads += 1;
    onRead?.();
    const subject: PRRuleSubject = {
      pr,
      headSha: head,
      title: 'PR',
      observedAt: new Date().toISOString(),
      facts: { state: { state: 'known', value: 'open' }, draft: { state: 'known', value: false } },
    };
    return { subjects: [subject], complete: true, errors: [], ignoredItems: 0 };
  };
  const store = await PRRuleStore.load(file);
  const runUpdates: Run[] = [];
  const serviceFor = (current: typeof store) =>
    new PRRuleService(
      current,
      () => authorized,
      () => {},
      collect,
      collect,
      undefined,
      undefined,
      undefined,
      (run) => runUpdates.push(structuredClone(run)),
    );
  const service = serviceFor(store);
  const team = await store.saveTeam('owner', {
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
  return {
    store,
    service,
    team,
    reads: () => reads,
    runUpdates,
    authorize: (value: boolean) => {
      authorized = value;
    },
    head: (value: string) => {
      head = value;
    },
    onRead: (hook?: () => void) => {
      onRead = hook;
    },
    restart: async () => {
      const next = await PRRuleStore.load(file);
      return { store: next, service: serviceFor(next) };
    },
  };
}

test('static admission captures the opt-in before persistence and rejects forged or edited snapshots', async (t) => {
  await fixture(t);
  const params = {
    flowType: 'review-pr' as const,
    project: 'farm',
    ticketOrPr: 'example/app#42',
    reviewWorkspaceTarget: { machine: 'review-node' },
    runner: 'codex',
    model: 'gpt-6-luna',
    effort: 'low',
    transport: 'native' as const,
    mode: 'autonomous' as const,
  };
  const { run } = await runWithSessionOriginator({ id: 'owner' } as Principal, () =>
    runCreate(params, () => {}, { awaitPersist: true }),
  );
  t.after(async () => {
    run.status = 'cancelled';
    await deleteRun(run.id);
  });
  assert.deepEqual(run.qaAfterReview?.selection.inputs, { scope: 'pr', environment: 'staging' });
  assert.deepEqual(run.qaAfterReview?.execution, execution);
  assert.equal(run.qaAfterReview?.state, 'pending');
  assert.throws(() => updateRun(run.id, { qaAfterReview: undefined }), /snapshot cannot/);
  assert.throws(
    () =>
      updateRun(run.id, {
        qaAfterReview: {
          ...run.qaAfterReview!,
          selection: { ...run.qaAfterReview!.selection, inputs: { scope: 'release' } },
        },
      }),
    /snapshot cannot/,
  );
  await assert.rejects(
    runCreate({ ...params, qaAfterReview: run.qaAfterReview } as never, () => {}),
    /cannot be supplied/,
  );
});

test('old reviews never backfill and concurrent/restarted reconciliation retains one automatic receipt', async (t) => {
  const f = await fixture(t);
  const old = source(t, false);
  await f.service.reconcileQaAfterReviews();
  assert.equal(f.store.snapshot().submissions?.length ?? 0, 0);
  assert.throws(
    () => updateRun(old.id, { qaAfterReview: captureQaAfterReview(qa, defaults) }),
    /snapshot cannot/,
  );
  const run = source(t);
  await Promise.all([f.service.reconcileQaAfterReviews(), f.service.reconcileQaAfterReviews()]);
  const receipt = f.store.snapshot().submissions![0];
  assert.equal(f.store.snapshot().submissions!.length, 1);
  assert.equal(receipt.request.idempotencyKey, automaticQaKey(run.id, 'pr'));
  assert.equal(receipt.request.sourceReviewRunId, run.id);
  assert.deepEqual(receipt.request.review?.qaInputs, { scope: 'pr', environment: 'staging' });
  assert.equal(run.qaAfterReview?.submissionId, receipt.id);
  assert(
    f.runUpdates.some(
      (updated) => updated.id === run.id && updated.qaAfterReview?.submissionId === receipt.id,
    ),
  );
  const snapshot = run.qaAfterReview!;
  updateRun(run.id, {
    qaAfterReview: { ...snapshot, state: 'pending', submissionId: undefined, intentId: undefined },
  });
  await persistRunNow(run, 'simulate lost follow-up link');
  const next = await f.restart();
  await next.service.reconcileQaAfterReviews();
  assert.equal(next.store.snapshot().submissions!.length, 1);
  assert.equal(run.qaAfterReview?.submissionId, receipt.id);
});

test('disabled and edited defaults block automatic QA without absorbing them or blocking explicit manual QA', async (t) => {
  const f = await fixture(t);
  const run = source(t);
  writeConfig({ ...config, qa: { ...qa, after_review: { ...qa.after_review, enabled: false } } });
  await f.service.reconcileQaAfterReviews();
  assert.match(run.qaAfterReview?.error ?? '', /disabled/);
  assert.equal(f.reads(), 0);
  writeConfig({
    ...config,
    qa: { ...qa, profiles: [{ ...qa.profiles[0], inputs: { scope: 'release' } }, qa.profiles[1]] },
  });
  await f.service.reconcileQaAfterReviews();
  assert.match(run.qaAfterReview?.error ?? '', /defaults changed/);
  assert.equal(run.qaAfterReview?.selection.inputs.scope, 'pr');
  writeConfig();
  await f.service.reconcileQaAfterReviews();
  const id = run.qaAfterReview!.submissionId!;
  writeConfig({ ...config, qa: { ...qa, after_review: { ...qa.after_review, enabled: false } } });
  const blocked = await f.service.refreshSubmission('owner', id);
  assert.match(blocked.error ?? '', /disabled/);
  assert.equal(f.store.intent(blocked.intentId!)?.contributions[0].eligible, false);
  const manual = await f.service.submit('owner', {
    ...blocked.request,
    idempotencyKey: 'manual',
    autoStart: false,
  });
  assert.equal((await f.service.refreshSubmission('owner', manual.id)).error, undefined);
});

test('owner, team mapping and exact PR head are current prerequisites', async (t) => {
  const f = await fixture(t);
  const run = source(t);
  f.authorize(false);
  await f.service.reconcileQaAfterReviews();
  assert.match(run.qaAfterReview?.error ?? '', /authority/);
  f.authorize(true);
  const duplicate = await f.store.saveTeam('owner', { ...f.team.config, name: 'Other team' });
  await f.service.reconcileQaAfterReviews();
  assert.match(run.qaAfterReview?.error ?? '', /unambiguous/);
  await f.store.saveTeam(
    'owner',
    { ...duplicate.config, repositories: [] },
    duplicate.id,
    duplicate.revision,
  );
  f.head('b'.repeat(40));
  await f.service.reconcileQaAfterReviews();
  assert.match(run.qaAfterReview?.error ?? '', /PR head changed/);
  const receiptId = run.qaAfterReview!.submissionId;
  f.head(HEAD);
  await f.service.reconcileQaAfterReviews();
  assert.equal(run.qaAfterReview?.state, 'submitted');
  assert.equal(run.qaAfterReview?.submissionId, receiptId);
  await f.store.saveTeam(
    'owner',
    { ...f.team.config, repositories: [] },
    f.team.id,
    f.team.revision,
  );
  await f.service.reconcileQaAfterReviews();
  assert.match(run.qaAfterReview?.error ?? '', /team mapping changed/);
});

test('completion and explicit cancellation never cause another automatic QA request', async (t) => {
  const f = await fixture(t);
  const run = source(t);
  await f.service.reconcileQaAfterReviews();
  const receipt = f.store.submission(run.qaAfterReview!.submissionId!, 'owner');
  await f.store.updateDispatch(receipt.intentId!, { status: 'completed', runId: 'completed-qa' });
  writeConfig({ ...config, qa: { ...qa, after_review: { enabled: true, profile_id: 'release' } } });
  const next = await f.restart();
  await next.service.reconcileQaAfterReviews();
  assert.equal(next.store.snapshot().submissions!.length, 1);
  assert.equal(run.qaAfterReview?.selection.profile.id, 'pr');
  assert.equal(run.qaAfterReview?.state, 'submitted');
  writeConfig();
  const cancelled = source(t);
  await next.service.reconcileQaAfterReviews();
  const pending = next.store.submission(cancelled.qaAfterReview!.submissionId!, 'owner');
  await next.store.cancelSubmission('owner', pending.id, pending.revision);
  await next.service.reconcileQaAfterReviews();
  assert.match(cancelled.qaAfterReview?.error ?? '', /cancelled/);
  assert.equal(next.store.snapshot().submissions!.length, 2);
});

test('policy edits during provider reads withdraw the pending automatic request', async (t) => {
  const f = await fixture(t);
  const run = source(t);
  f.onRead(() =>
    writeConfig({ ...config, qa: { ...qa, after_review: { ...qa.after_review, enabled: false } } }),
  );
  await f.service.reconcileQaAfterReviews();
  assert.equal(run.qaAfterReview?.state, 'blocked');
  assert.match(run.qaAfterReview?.error ?? '', /disabled/);
  assert.equal(f.store.snapshot().intents.length, 0);
  assert.equal(getRun(run.id)?.qaAfterReview?.selection.profile.id, 'pr');
});

test('an already-started identical manual QA satisfies the follow-up without another request', async (t) => {
  const f = await fixture(t);
  const run = source(t);
  const manual = await f.service.submit('owner', {
    teamId: f.team.id,
    pr,
    sourceReviewRunId: run.id,
    idempotencyKey: 'manual-first',
    autoStart: true,
    source: { client: 'test' },
    review: run.qaAfterReview!.review,
    execution,
  });
  const receipt = await f.service.refreshSubmission('owner', manual.id);
  const child = createRun(
    { flowType: 'qa', project: 'farm', ticketOrPr: 'example/app#42', parentRunId: run.id },
    {
      createdByPrincipalId: 'owner',
      deferBackgroundPersist: true,
      reviewQa: { flowType: 'qa', contract: { version: 1 }, qa: run.qaAfterReview!.selection },
    },
  );
  child.status = 'done';
  t.after(() => deleteRun(child.id));
  await f.store.updateDispatch(receipt.intentId!, { status: 'completed', runId: child.id });
  await f.service.reconcileQaAfterReviews();
  assert.equal(f.store.snapshot().submissions!.length, 1);
  assert.equal(run.qaAfterReview?.submissionId, receipt.id);
  const next = await f.restart();
  await next.service.reconcileQaAfterReviews();
  assert.equal(next.store.snapshot().submissions!.length, 1);
  assert.equal(run.qaAfterReview?.state, 'submitted');
});

test('archived reviews retain automatic QA authority and serialized delivery state', async (t) => {
  const f = await fixture(t);
  const run = source(t);
  const snapshot = structuredClone(run.qaAfterReview);
  await Promise.all([
    archiveRun(run.id),
    updateQaFollowUp(run.id, { state: 'blocked', error: 'temporary policy hold' }),
  ]);
  assert.equal(getRun(run.id), undefined);
  assert.equal((await getRunWithArchived(run.id))?.qaAfterReview?.error, 'temporary policy hold');
  await f.service.reconcileQaAfterReviews();
  const archived = (await getRunWithArchived(run.id))!;
  const id = archived.qaAfterReview!.submissionId!;
  assert(id);
  assert.deepEqual(archived.qaAfterReview!.selection, snapshot!.selection);
  assert(archived.archivedAt);
  assert.equal(getRun(run.id), undefined);
  assert.equal(
    f.runUpdates.filter((updated) => updated.id === run.id).length,
    0,
    'Archived updates must not revive active UI rows',
  );
  const restarted = await f.restart();
  await restarted.service.reconcileQaAfterReviews();
  assert.equal(restarted.store.snapshot().submissions!.length, 1);
  writeConfig({ ...config, qa: { ...qa, after_review: { ...qa.after_review, enabled: false } } });
  const blocked = await restarted.service.refreshSubmission('owner', id);
  assert.match(blocked.error ?? '', /disabled/);
  assert.equal(restarted.store.intent(blocked.intentId!)?.contributions[0].eligible, false);
  assert.equal(getRun(run.id), undefined);
});
