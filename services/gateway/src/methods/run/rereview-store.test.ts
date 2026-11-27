import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, mock, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { PRWorkReference, Run, RunCreateParams } from '@farmslot/protocol';

const root = await mkdtemp(path.join(os.tmpdir(), 'rereview-store-'));
after(() => rm(root, { recursive: true, force: true }));
process.env.FARMSLOT_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));
process.env.FARMSLOT_HOME = path.join(root, 'home');
process.env.FARMSLOT_RUNS_DIR = path.join(root, 'runs');
process.env.FARMSLOT_PROJECTS_DIR = path.join(root, 'projects');
process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = 'rereview-owner';
for (const dir of ['home', 'runs', 'projects/review-fixture'])
  await mkdir(path.join(root, dir), { recursive: true });
await writeFile(
  path.join(root, 'projects/review-fixture/project.json'),
  JSON.stringify({
    name: 'review-fixture',
    repo_url: 'https://github.com/owner/repo.git',
    ci: { repo: 'owner/repo' },
  }),
);
await import('../../runtime/mock-pty.test-support.js');
const { CredentialStoreRuntime, CredentialStoreWriter } =
  await import('@farmslot/credential-store');
const runtime = new CredentialStoreRuntime({ FARMSLOT_HOME: path.join(root, 'home') });
const writer = new CredentialStoreWriter(runtime, true);
const owner = writer.createPrincipal(
  { type: 'service', displayName: 'Re-review owner' },
  [{ role: 'admin', scope: { kind: 'global' } }],
  'rereview-owner',
);
const other = writer.createPrincipal(
  { type: 'service', displayName: 'Other owner' },
  [{ role: 'admin', scope: { kind: 'global' } }],
  'other-owner',
);
const github = await import('../../external/github.js');
mock.module('../../external/github.js', {
  namedExports: {
    ...github,
    fetchGitHubPR: async () => ({ headSha: 'c'.repeat(40), baseSha: 'b'.repeat(40), number: 42 }),
  },
});
const fleet = await import('../../fleet/state.js');
mock.module('../../fleet/state.js', {
  namedExports: {
    ...fleet,
    loadProjectConfig: async () => ({
      ci: { repo: 'owner/repo' },
      staticReview: { templateId: 'review-pr/default' },
    }),
    loadPoolConfigs: async () => [
      {
        machine: 'review-node',
        project: 'review-fixture',
        slots: [],
        reviewWorkspaces: { enabled: true },
      },
    ],
    loadFleetStatus: async () => ({ slots: [] }),
  },
});
const admission = await import('../../review-workspaces/admission.js');
mock.module('../../review-workspaces/admission.js', {
  namedExports: {
    ...admission,
    resolveWorkspaceReviewTemplate: async () => ({
      id: 'review-pr/default',
      sourceId: 'review-fixture',
      flow: 'review-pr',
      platforms: ['mobile'],
      labels: [],
      relativePath: 'templates/review-pr/default.md',
      sha256: 'c'.repeat(64),
    }),
  },
});
const engine = await import('../../run-engine/orchestrator.js');
mock.module('../../run-engine/orchestrator.js', {
  namedExports: { ...engine, startRun: async () => {}, applyChainedRunEngineFlags: () => {} },
});
const {
  createRun,
  getAllRuns,
  getRun,
  updateRun,
  deleteRun,
  loadAllRuns,
  persistRunNow,
  runsDirectory,
} = await import('../../runs/store.js');
const { runWithSessionOriginator } = await import('../../security/work-originator.js');
const { runRereviewLatestHead } = await import('./rereview.js');
const { assertPRRunActivation } = await import('../../backlog/pr-admission.js');
const owned = <T>(fn: () => T) => runWithSessionOriginator(owner, fn);
const reference: PRWorkReference = {
  kind: 'review',
  id: 'review:fixture-intent',
  sourceId: 'fixture-intent',
  pr: { host: 'github.com', repo: 'owner/repo', number: 42 },
  headSha: 'a'.repeat(40),
};

afterEach(async () => {
  for (const run of getAllRuns()) {
    // Awaited, so no queued background write recreates the file after its deletion.
    await persistRunNow(updateRun(run.id, { status: 'done', reviewWorkspace: undefined }), 'test');
    await deleteRun(run.id);
  }
});

function blockedParent(): Run {
  const run = owned(() =>
    createRun({
      project: 'review-fixture',
      flowType: 'review-pr',
      ticketOrPr: 'owner/repo#42',
      transport: 'tmux',
      reviewWorkspaceTarget: { machine: 'review-node' },
      runner: 'codex',
      model: 'gpt-6-astra',
      effort: 'high',
      completionPolicy: 'artifact-only',
      reviewAutoFinish: false,
    }),
  );
  const at = new Date().toISOString();
  updateRun(run.id, { status: 'blocked' });
  return updateRun(run.id, {
    prWork: reference,
    reviewWorkspace: {
      workspaceId: 'workspace-' + run.id,
      machine: 'review-node',
      executionNodeId: 'review-node',
      checkoutPath: path.join(root, 'source'),
      taskPath: path.join(root, 'task'),
      artifactPath: path.join(root, 'task/artifacts'),
      retainedAt: at,
      executionStoppedAt: at,
    },
    reviewWorkspaceSubject: {
      repository: 'owner/repo',
      repositoryUrl: 'https://github.com/owner/repo.git',
      headSha: 'a'.repeat(40),
      baseSha: 'b'.repeat(40),
      branch: 'feature',
      title: 'Review',
      body: '',
      capturedAt: at,
    },
    agentContexts: [
      {
        id: 'review',
        role: 'review',
        label: 'Review',
        status: 'complete',
        runId: run.id,
        slotId: null,
        runner: 'codex',
        model: 'gpt-6-astra',
        effort: 'high',
        reviewId: 'retained-lineage',
        runnerSessionId: 'retained-conversation',
        reviewResultValidatedAt: at,
      },
    ],
    reviewResult: {
      recommendation: 'REQUEST_CHANGES',
      reviewMd: 'Prior finding',
      lineComments: [],
      session: {
        mode: 'cold',
        continuity: 'fresh',
        reviewId: 'retained-lineage',
        sessionId: 'retained-conversation',
        repository: 'owner/repo',
        prNumber: 42,
        lastReviewedHeadSha: 'a'.repeat(40),
      },
      reviewSnapshot: {
        source: 'github-pr',
        headSha: 'a'.repeat(40),
        baseSha: 'b'.repeat(40),
        capturedAt: at,
      },
    },
  });
}

test('real store admits an owned stopped blocked intake review successor', async () => {
  const parent = blockedParent();
  const result = await owned(() => runRereviewLatestHead({ runId: parent.id }));
  assert.equal(result.mode, 'warm-handoff');
  const child = getRun(result.runId!);
  assert.ok(child);
  assert.equal(child.parentRunId, parent.id);
  assert.equal(child.familyId, parent.familyId);
  assert.equal(child.nativeOwnerPrincipalId, owner.id);
  assert.equal(child.createdByPrincipalId, owner.id);
  assert.equal(child.reviewMode, 'warm');
  assert.equal(child.reviewAutoFinish, false);
  assert.equal(child.reviewContext?.reviewLineages[0]?.reviewId, 'retained-lineage');
  assert.equal(getRun(parent.id)!.status, 'done');
  assert.throws(
    () =>
      assertPRRunActivation(
        { ...parent, id: 'next-automated-review', status: 'created' },
        getAllRuns(),
      ),
    /PR execution is owned by run/,
    'the manual successor keeps automated activation fenced',
  );
});

test('real store keeps an unrelated legacy PR owner fenced during successor admission', async () => {
  const parent = blockedParent();
  const unrelated: Run = {
    ...structuredClone(parent),
    id: 'unrelated-legacy-owner',
    familyId: 'unrelated-legacy-owner',
    prWork: { ...reference, id: 'review:unrelated-intent', sourceId: 'unrelated-intent' },
  };
  await writeFile(path.join(runsDirectory(), unrelated.id + '.json'), JSON.stringify(unrelated));
  await loadAllRuns();
  await assert.rejects(
    owned(() => runRereviewLatestHead({ runId: parent.id })),
    /PR execution is owned by run unrelated-legacy-owner/,
  );
  assert.equal(getAllRuns().length, 2);
  assert.equal(getRun(parent.id)!.status, 'blocked');
});

test('a foreign service cannot hand off an owned blocked review', async () => {
  const parent = blockedParent();
  await assert.rejects(
    runWithSessionOriginator(other, () => runRereviewLatestHead({ runId: parent.id })),
    /another principal/,
  );
  assert.equal(getAllRuns().length, 1);
  assert.equal(getRun(parent.id)!.status, 'blocked');
});

function successorRequest(parent: Run): RunCreateParams {
  return {
    project: parent.project,
    flowType: 'review-pr',
    ticketOrPr: 'owner/repo#42',
    parentRunId: parent.id,
    transport: 'tmux',
    reviewWorkspaceTarget: parent.reviewWorkspaceTarget,
    runner: 'codex',
    model: 'gpt-6-astra',
    effort: 'high',
    reviewMode: 'warm',
    reviewContext: {
      reviewLineages: [{ repository: 'owner/repo', prNumber: 42, reviewId: 'retained-lineage' }],
    },
  };
}

test('real store refuses stale or mismatched predecessor admission before supersession', () => {
  const parent = blockedParent();
  const request = successorRequest(parent);
  const admission = {
    runId: parent.id,
    generation: parent.engineState?.generation ?? 0,
    reviewId: 'retained-lineage',
  };
  for (const invalid of [
    { ...admission, generation: admission.generation + 1 },
    { ...admission, reviewId: 'different-lineage' },
    { ...admission, runId: 'different-parent' },
  ]) {
    assert.throws(
      () => owned(() => createRun(request, { reviewPredecessor: invalid })),
      /predecessor changed/,
    );
  }
  assert.throws(
    () =>
      owned(() =>
        createRun({ ...request, ticketOrPr: 'owner/other#42' }, { reviewPredecessor: admission }),
      ),
    /predecessor changed/,
  );
  updateRun(parent.id, {
    reviewWorkspace: { ...parent.reviewWorkspace!, executionStoppedAt: undefined },
  });
  assert.throws(
    () => owned(() => createRun(request, { reviewPredecessor: admission })),
    /predecessor changed/,
  );
  assert.equal(getAllRuns().length, 1);
  assert.equal(parent.status, 'blocked');
});

test('public run parameters cannot supply predecessor admission', () => {
  const parent = blockedParent();
  assert.throws(
    () =>
      owned(() =>
        createRun({
          ...successorRequest(parent),
          // @ts-expect-error Predecessor admission is an internal store option, never a run parameter.
          reviewPredecessor: { runId: parent.id, generation: 0, reviewId: 'retained-lineage' },
        }),
      ),
    /admission is gateway-owned/,
  );
  assert.equal(getAllRuns().length, 1);
  assert.equal(parent.status, 'blocked');
});
