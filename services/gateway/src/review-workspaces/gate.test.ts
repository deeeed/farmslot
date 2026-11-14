import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test, type TestContext } from 'node:test';

import type {
  PRTeamProfile,
  ReviewPublicationReceipt,
  RunDecision,
  RunReviewResult,
} from '@farmslot/protocol';

const root = await mkdtemp(path.join(os.tmpdir(), 'review-post-retry-'));
Object.assign(process.env, {
  FARMSLOT_ROOT: root,
  FARMSLOT_HOME: path.join(root, 'home'),
  FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
  FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
  FARMSLOT_POOL_DIR: path.join(root, 'pool'),
});
await mkdir(path.join(root, 'projects/review'), { recursive: true });
await writeFile(
  path.join(root, 'projects/review/project.json'),
  JSON.stringify({ name: 'review', ci: { repo: 'example/app' } }),
);
for (const file of ['CLAUDE.md', 'scripts/dev.sh', 'services/gateway/package.json']) {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), file.endsWith('.json') ? '{}' : '# Fixture\n');
}

const { createGatewayAuthRuntime } = await import('../security/auth.js');
const { ownerAdminAuthority } = await import('../security/authorization.js');
const auth = createGatewayAuthRuntime({ FARMSLOT_HOME: path.join(root, 'home') });
const owner = auth.writer.createPrincipal({ type: 'person', displayName: 'Review gate fixture' }, [
  { role: 'admin', scope: { kind: 'global' } },
]);
process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = owner.id;
const at = '2026-11-15T00:00:00.000Z';
const account = { host: 'github.com', login: 'reviewer' };
const team: PRTeamProfile = {
  id: randomUUID(),
  ownerId: owner.id,
  revision: 1,
  createdAt: at,
  updatedAt: at,
  config: {
    name: 'Review fixture',
    account,
    sources: [{ kind: 'repository', repo: 'example/app' }],
    predicate: { kind: 'compare', field: 'state', operator: 'equals', value: 'open' },
    repositories: [
      { repo: 'example/app', project: 'review', reviewProfile: 'standard', excludedLabels: [] },
    ],
    execution: {
      workspacePolicy: { kind: 'exact', machine: 'fixture' },
      transport: 'tmux',
      models: [{ runner: 'claude', model: 'claude-opus-5-5', effort: 'high', mode: 'cold' }],
    },
    githubTeams: [],
    notificationPrincipalIds: [],
  },
};
const { captureDirectReviewPublication, setDirectPublicationAuthority } =
  await import('../review-publication/direct.js');
const authorized = ownerAdminAuthority(auth);
setDirectPublicationAuthority({
  teams: (id) => (id === owner.id ? [team] : []),
  authorize: (id, generation) => assert.ok(authorized(id, generation)),
});
const { createRun, deleteRun, getRun, persistRunNow, updateRun, updateReviewPublication } =
  await import('../runs/store.js');
const { hasEngineDecisionWaiter, recordDecisionResolution, resolveEngineDecision } =
  await import('../run-engine/engine-decisions.js');
const { holdWorkspaceReview } = await import('./gate.js');
after(() => rm(root, { recursive: true, force: true }));

interface GateFixture {
  id: string;
  report: RunReviewResult;
  previous: RunDecision;
}

async function fixture(t: TestContext, replay = false): Promise<GateFixture> {
  const direct = captureDirectReviewPublication(
    {
      project: 'review',
      flowType: 'review-pr',
      ticketOrPr: 'example/app#42',
      publishReview: false,
    },
    undefined,
    owner.id,
  );
  assert.ok(direct);
  assert.equal(direct.requested, false);
  const run = createRun(
    {
      project: 'review',
      flowType: 'review-pr',
      mode: 'interactive',
      ticketOrPr: 'example/app#42',
      runner: 'claude',
      transport: 'tmux',
      publishReview: false,
      reviewWorkspaceTarget: { machine: 'fixture' },
    },
    {
      createdByPrincipalId: owner.id,
      nativeOwnerPrincipalId: owner.id,
      directReviewPublication: direct,
    },
  );
  t.after(async () => {
    updateRun(run.id, { status: 'done' });
    await deleteRun(run.id);
  });
  const task = path.join(root, 'tasks', run.id);
  await mkdir(task, { recursive: true });
  await writeFile(path.join(task, 'TASK.md'), '# Saved static review\n');
  const report: RunReviewResult = {
    recommendation: 'APPROVE',
    reviewMd: 'Current saved report.',
    lineComments: [],
    reviewSnapshot: { source: 'github-pr', headSha: 'a'.repeat(40), capturedAt: at },
  };
  const previous: RunDecision = {
    id: randomUUID(),
    type: 'engine_review_posting',
    title: 'Previous Post',
    description: '',
    actions: [{ id: 'post', label: 'Post', style: 'primary' }],
    createdAt: at,
    resolvedAt: at,
    resolvedAction: 'post',
    payload: {
      kind: 'review',
      repo: 'example/app',
      prNumber: 42,
      ...report,
      reviewMd: replay ? report.reviewMd : 'Previously approved report.',
    },
  };
  const publication = captureDirectReviewPublication(
    { project: 'review', flowType: 'review-pr', ticketOrPr: 'example/app#42', publishReview: true },
    undefined,
    owner.id,
  );
  assert.ok(publication?.policy.enabled);
  updateRun(run.id, {
    status: 'human-gating',
    taskFile: path.join(task, 'TASK.md'),
    prNumber: 42,
    reviewResult: report,
    reviewWorkspaceSubject: {
      repository: 'example/app',
      repositoryUrl: 'https://github.com/example/app.git',
      headSha: 'a'.repeat(40),
      baseSha: 'b'.repeat(40),
      branch: 'reviewed',
      title: 'Fixture',
      body: '',
      capturedAt: at,
    },
    reviewWorkspace: {
      workspaceId: randomUUID(),
      machine: 'fixture',
      executionNodeId: 'fixture',
      checkoutPath: path.join(task, 'checkout'),
      taskPath: task,
      artifactPath: path.join(task, 'artifacts'),
      cleanedAt: at,
    },
    decisions: [previous],
    reviewPublication: {
      ...run.reviewPublication,
      // Replay may recover a resolution whose gate snapshot never committed.
      gate: { decisionId: replay ? 'older-gate' : previous.id, publication },
      error: 'Earlier publication failed',
      checkedAt: at,
    },
  });
  await persistRunNow(getRun(run.id)!, 'gate fixture');
  return { id: run.id, report, previous };
}

async function explicitChoice(f: GateFixture, action: 'post' | 'dismiss') {
  const execution = holdWorkspaceReview(f.id);
  let decision: RunDecision | undefined;
  for (let attempt = 0; attempt < 200; attempt++) {
    decision = getRun(f.id)!.decisions.find((entry) => !entry.resolvedAt);
    if (decision && hasEngineDecisionWaiter(decision.id)) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(decision && hasEngineDecisionWaiter(decision.id), 'explicit gate owns its waiter');
  recordDecisionResolution(f.id, decision.id, action);
  assert.equal(resolveEngineDecision(decision.id, action), true);
  assert.equal((await execution).action, action);
  return getRun(f.id)!;
}

test('a fresh explicit Post clears the failed publication and retains the saved report', async (t) => {
  const f = await fixture(t);
  const after = await explicitChoice(f, 'post');
  assert.equal(after.reviewPublication?.error, undefined);
  assert.notEqual(after.reviewPublication?.gate?.decisionId, f.previous.id);
  assert.deepEqual(after.reviewResult, f.report);
  assert.equal(after.reviewPublication?.direct?.requested, false);
  assert.equal(after.reviewPublication?.gate?.publication.requested, true);
});

test('a fresh explicit Post preserves the uncertain provider receipt byte for byte', async (t) => {
  const f = await fixture(t);
  const receipt: ReviewPublicationReceipt = {
    version: 1,
    state: 'posting',
    runId: f.id,
    ownerId: owner.id,
    account,
    pr: { host: 'github.com', repo: 'example/app', number: 42 },
    headSha: 'a'.repeat(40),
    contentSha256: 'c'.repeat(64),
    marker: `<!-- farmslot-review:${'d'.repeat(64)} -->`,
    event: 'APPROVE',
    attemptedAt: at,
  };
  await updateReviewPublication(f.id, { receipt });
  const before = JSON.stringify(getRun(f.id)!.reviewPublication!.receipt);
  const after = await explicitChoice(f, 'post');
  assert.equal(after.reviewPublication?.error, undefined);
  assert.equal(JSON.stringify(after.reviewPublication?.receipt), before);
});

test('replaying Post preserves its failure even when the saved gate id differs', async (t) => {
  const f = await fixture(t, true);
  assert.equal((await holdWorkspaceReview(f.id)).action, 'post');
  const after = getRun(f.id)!;
  assert.equal(after.reviewPublication?.gate?.decisionId, f.previous.id);
  assert.equal(after.reviewPublication?.error, 'Earlier publication failed');
  assert.equal(after.decisions.length, 1, 'replay asks for no new explicit choice');
});

test('a fresh Dismiss leaves the previous failure intact and disables publication', async (t) => {
  const f = await fixture(t);
  const after = await explicitChoice(f, 'dismiss');
  assert.equal(after.reviewPublication?.error, 'Earlier publication failed');
  assert.equal(after.reviewPublication?.gate?.publication.policy.enabled, false);
});
