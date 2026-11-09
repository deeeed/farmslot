// @farmslot:serial — creates and removes real JSON under the shared repo `pool/`.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, mock, test, type TestContext } from 'node:test';

import {
  APPROVE_PUBLISH_ACTION,
  buildRunResolveDecisionParams,
  Events,
  type ReadyGatePayload,
  type ReadyGatePrPackage,
  type ReviewPolicy,
  type RunDecision,
} from '@farmslot/protocol';

await import('../runtime/mock-pty.test-support.js');
const github = await import('../integrations/github-client.js');
const githubCalls: string[][] = [];
mock.module('../integrations/github-client.js', {
  namedExports: {
    ...github,
    ghRequest: async (args: string[]) => {
      githubCalls.push(args);
      throw new Error('Unexpected GitHub call');
    },
  },
});
const linkage = await import('../integrations/pr-linkage.js');
// The gate asks GitHub whether the branch already merged; the fixture's project names a real repo.
mock.module('../integrations/pr-linkage.js', {
  namedExports: { ...linkage, findMergedPRNumber: async () => null },
});
const { execLocal } = await import('../core/exec.js');
const probes = await import('../core/read-probes.js');
// The reviewed-inputs command itself, without a login shell around every read of it.
mock.module('../core/read-probes.js', {
  namedExports: {
    ...probes,
    readSlotProbe: (_vars: unknown, command: string, _scope: string, timeout: number) =>
      execLocal(command, { timeout }),
  },
});
const completion = await import('../run-completion/orchestrator.js');

const publications: ReadyGatePrPackage[] = [];
// Script package capture and the outward publication; the refresh, gate readiness, resolve and
// finalize owners are real. No worker or reviewer is launched and nothing leaves this machine.
mock.module('../run-completion/orchestrator.js', {
  namedExports: {
    ...completion,
    assertReadyGatePackageInputsCurrent: async (_run: unknown, prepared: ReadyGatePrPackage) =>
      prepared,
    extractAndPersistSessionCost: async () => ({}),
    prepareCompletionPackageTransitionLocked: async (
      runId: string,
      options: { reviewPolicy?: ReviewPolicy; expectedHeadSha?: string; headSha?: string },
    ) => {
      const run = getRun(runId)!;
      const headSha = options.expectedHeadSha ?? options.headSha!;
      // The one policy expression the real preparation uses.
      const reviewPolicy = publicationReviewPolicyForRun(
        run,
        undefined,
        options.reviewPolicy ?? run.engineState?.publishGate?.reviewPolicy,
      );
      const prPackage = packageAt(headSha, reviewPolicy, `pkg-${headSha.slice(0, 8)}`);
      prPackage.artifactBundle = run.artifactBundle;
      prPackage.packageHash = computeReadyGatePackageHash(prPackage);
      return {
        prPackage,
        reviews: run.engineState?.publishGate?.reviews ?? [],
        commit: async () => {
          updateRun(runId, {
            engineState: {
              ...getRun(runId)!.engineState,
              publishGate: {
                ...getRun(runId)!.engineState?.publishGate,
                packageId: prPackage.id,
                packageHash: prPackage.packageHash,
                reviewPolicy,
              },
            },
          });
        },
      };
    },
    publishCompletionPackage: async (_runId: string, approved: ReadyGatePrPackage) => {
      publications.push(approved);
      throw new Error('publication reached');
    },
  },
});

const { farmslotRoot } = await import('../fleet/state.js');
const { runResolveDecision } = await import('../methods/run.js');
const { capturePublicationSource } = await import('../run-completion/publication-source.js');
const { computeReadyGatePackageHash, readReadyGatePreparedPackage } =
  await import('../run-completion/ready-gate-package.js');
const { createRun, getRun, updateRun } = await import('../runs/store.js');
const { noteReviewInputsAtLaunch, readReviewedInputs, recordReviewedInputs } =
  await import('../review/reviewed-inputs.js');
const { latestResolvedHumanGateDecision } = await import('./decision-replay.js');
const { executeFinalizeStep }: typeof import('./finalize-step.js') = await import(
  new URL('./finalize-step.js?gate-refresh-policy', import.meta.url).href
);
const { setEngineDecisionRuntime } = await import('./engine-decisions.js');
const { stampPublishGateReviewStatusForPackage, supersedeStaleHumanGateDecisions } =
  await import('./gate-policy.js');
const { executeReadyGate } = await import('./ready-gate.js');
const { publicationReviewPolicyForRun } = await import('./publication-policy.js');
const {
  reconcilePublicationPackageForInspection,
  refreshPublishPackage,
}: typeof import('./publish-package-refresh.js') = await import(
  new URL('./publish-package-refresh.js?gate-refresh-policy', import.meta.url).href
);
const { certifyingReview, PASSING_REVIEW_RESULT } = await import('./review-claim.test-support.js');
const { deleteTestRunIfPresent, makeReadyGatePackage, retainRunFixture } =
  await import('./test-fixtures.js');

const RESULT = 'artifacts/review-1/loop-1/review-result.json';

afterEach(() => assert.deepEqual(githubCalls, [], 'no test reaches GitHub'));

function packageAt(headSha: string, reviewPolicy: ReviewPolicy, id = 'pkg-reviewed') {
  const prepared = makeReadyGatePackage({ id, headSha, reviewPolicy, branch: 'main' });
  prepared.packageHash = computeReadyGatePackageHash(prepared);
  return prepared;
}

async function headOf(repo: string): Promise<string> {
  return (await execLocal('git rev-parse HEAD', { cwd: repo })).stdout.trim();
}

/**
 * A dev gate on a real local slot whose HEAD is on the new commit, showing the package at `shownAt`
 * with a passing review at `reviewedAt`.
 */
async function gateFixture(
  t: TestContext,
  policy: ReviewPolicy,
  reviewedAt: 'old' | 'new',
  shownAt: 'old' | 'new' = 'old',
) {
  const testId = `gate-refresh-policy-${process.pid}-${Date.now()}`;
  const repo = await mkdtemp(path.join(os.tmpdir(), `${testId}-`));
  const taskDir = path.join(farmslotRoot(), '.sandbox/farmslot-farm/tasks/test', testId);
  const poolFile = path.join(farmslotRoot(), 'pool', `${testId}.json`);
  const slotId = `${testId}-slot`;
  const run = createRun({
    flowType: 'dev',
    mode: 'autonomous',
    project: 'farmslot-farm',
    ticketOrPr: 'GATE-REFRESH-POLICY',
    runner: 'claude',
  });
  t.after(async () => {
    await deleteTestRunIfPresent(run.id);
    await rm(taskDir, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
    await rm(poolFile, { force: true });
  });
  await mkdir(path.join(taskDir, 'artifacts/review-1/loop-1'), { recursive: true });
  await writeFile(path.join(taskDir, 'TASK.md'), '# Gate refresh\n');
  await writeFile(path.join(taskDir, RESULT), PASSING_REVIEW_RESULT);
  await writeFile(path.join(repo, 'f.txt'), 'one\n');
  await execLocal(
    'git init -b main && git config user.email test@example.com && git config user.name Test && git add . && git commit -m one',
    { cwd: repo },
  );
  const oldHead = await headOf(repo);
  await writeFile(path.join(repo, 'f.txt'), 'two\n');
  await execLocal('git add . && git commit -m two', { cwd: repo });
  const newHead = await headOf(repo);
  await writeFile(
    poolFile,
    JSON.stringify({
      machine: 'localhost',
      project: 'farmslot-farm',
      platform: 'cli',
      os: 'darwin',
      host: 'localhost',
      ssh_user: os.userInfo().username,
      slots: [{ id: slotId, enabled: true, repo, session: slotId }],
    }),
  );
  const shown = packageAt(shownAt === 'new' ? newHead : oldHead, policy);
  const reviewedPackage = packageAt(reviewedAt === 'new' ? newHead : oldHead, policy);
  const decision: RunDecision = {
    id: 'gate',
    type: 'engine_human_gate',
    title: 'Publish',
    description: '',
    createdAt: '2026-11-03T00:00:00Z',
    actions: [
      { id: APPROVE_PUBLISH_ACTION, label: 'Approve Publish', style: 'primary' },
      { id: 'hold', label: 'Hold', style: 'secondary' },
      { id: 'request-review', label: 'Request review', style: 'secondary' },
    ],
    payload: {
      kind: 'ready',
      prNumber: null,
      repo: null,
      workerReport: '',
      branch: shown.branch,
      diffStat: shown.diffStat,
      headSha: shown.headSha,
      reviewPolicy: policy,
      prPackage: shown,
    },
  };
  updateRun(run.id, {
    status: 'human-gating',
    slotId,
    branch: 'main',
    taskFile: path.join(taskDir, 'TASK.md'),
    decisions: [decision],
    engineState: {
      generation: 0,
      publishGate: {
        reviewPolicy: policy,
        reviews: [{ ...certifyingReview(reviewedPackage), artifactPaths: [RESULT] }],
        publicationStatus: 'not_published',
        packageId: shown.id,
        packageHash: shown.packageHash,
      },
    },
  });
  await retainRunFixture(getRun(run.id)!, shown);
  const refresh = () =>
    refreshPublishPackage(
      { runId: run.id, decisionId: decision.id },
      {
        progress: async () => ({ kind: 'idle' }),
        source: (current) =>
          capturePublicationSource(current, {
            slot: async () => ({ current_run_id: current.id, slot_epoch: 1 }),
          }),
      },
    );
  // What every run.get and decision list does to a gate whose head moved.
  const readGate = () =>
    reconcilePublicationPackageForInspection(getRun(run.id)!, {
      head: async () => newHead,
      progress: async () => ({ kind: 'idle' }),
      refresh: async () => (await refresh()).run,
    });
  const workerArtifacts = path.join(
    repo,
    '.sandbox/farmslot-farm/worker-task/test',
    testId,
    'artifacts',
  );
  return { run, decision, newHead, oldHead, refresh, readGate, workerArtifacts };
}

const resolveApproval = (runId: string, card: RunDecision) =>
  runResolveDecision(
    buildRunResolveDecisionParams({ runId, decision: card, actionId: APPROVE_PUBLISH_ACTION }),
    () => {},
    { resumeRun: async () => {} },
  );

const finalize = (runId: string) =>
  executeFinalizeStep(runId, {
    broadcastFn: () => {},
    latestResolvedHumanGateDecision,
    loadProjectVarsOrNull: async () => null,
    readPreparedPackage: readReadyGatePreparedPackage,
    refreshRunLinks: async () => {},
    stepPartialIO: new Map(),
  });

const card = (runId: string, decisionId: string) =>
  getRun(runId)!.decisions.find((entry) => entry.id === decisionId)!;

for (const requestedBy of ['human-gate', 'dispatch'] as const)
  test(`a refresh at a new head keeps a ${requestedBy} review required on the card, at resolve and at finalize`, async (t) => {
    publications.length = 0;
    const policy = { minimumReviews: 1, requestedBy };
    const { run, decision, newHead, readGate } = await gateFixture(t, policy, 'old');
    await readGate();
    const refreshed = card(run.id, decision.id);
    const payload = refreshed.payload as ReadyGatePayload;
    assert.equal(payload.prPackage?.headSha, newHead);
    assert.deepEqual(payload.prPackage?.reviewPolicy, policy);
    assert.deepEqual(getRun(run.id)!.engineState?.publishGate?.reviewPolicy, policy);
    assert.deepEqual(
      refreshed.actions.map(({ id }) => id),
      ['hold', 'request-review'],
    );
    assert.deepEqual(
      payload.gateReadiness?.reasons.map(({ code }) => code),
      ['review-result-required'],
    );

    await assert.rejects(resolveApproval(run.id, refreshed), /Action not found/);
    // A client that still lists the action gets the review refusal, not only a missing action.
    updateRun(run.id, {
      decisions: getRun(run.id)!.decisions.map((entry) =>
        entry.id === decision.id
          ? {
              ...entry,
              context: {
                ...entry.context,
                gateActions: [
                  { id: APPROVE_PUBLISH_ACTION, label: 'Approve Publish', style: 'primary' },
                ],
              },
            }
          : entry,
      ),
    });
    await assert.rejects(
      resolveApproval(run.id, card(run.id, decision.id)),
      /requires passing reviews/,
    );
    assert.equal(card(run.id, decision.id).resolvedAt, undefined);

    // Finalize trusts no recorded approval: it refuses the same head again.
    updateRun(run.id, {
      status: 'completing',
      decisions: getRun(run.id)!.decisions.map((entry) =>
        entry.id === decision.id
          ? {
              ...entry,
              resolvedAt: '2026-11-03T00:01:00Z',
              resolvedAction: APPROVE_PUBLISH_ACTION,
              selectionData: {
                packageId: payload.prPackage!.id,
                packageHash: payload.prPackage!.packageHash,
                packageHeadSha: payload.prPackage!.headSha,
              },
            }
          : entry,
      ),
    });
    await assert.rejects(finalize(run.id), /requires passing reviews/);
    assert.deepEqual(publications, []);
  });

test('a review at the new head satisfies the kept requirement, and a stale approval still refuses', async (t) => {
  publications.length = 0;
  const policy = { minimumReviews: 1, requestedBy: 'human-gate' as const };
  const { run, decision, newHead, oldHead, refresh } = await gateFixture(t, policy, 'new');
  const beforeRefresh = card(run.id, decision.id);
  await refresh();
  const refreshed = card(run.id, decision.id);
  assert.equal(refreshed.id, beforeRefresh.id, 'a refresh keeps the decision id at a new head');
  assert.deepEqual((refreshed.payload as ReadyGatePayload).prPackage?.reviewPolicy, policy);
  assert.ok(refreshed.actions.some(({ id }) => id === APPROVE_PUBLISH_ACTION));
  // The same id cannot carry an approval of the older package: it binds to the package itself.
  assert.equal((beforeRefresh.payload as ReadyGatePayload).prPackage?.headSha, oldHead);
  await assert.rejects(resolveApproval(run.id, beforeRefresh), {
    message: `Package changed; refresh package and re-review before publishing (approved package pkg-reviewed but current package is pkg-${newHead.slice(0, 8)})`,
  });
  assert.equal(card(run.id, decision.id).resolvedAt, undefined);

  await resolveApproval(run.id, refreshed);
  await assert.rejects(finalize(run.id), /publication reached/);
  assert.deepEqual(
    publications.map(({ headSha }) => headSha),
    [newHead],
  );
});

/** A human/1 gate refreshed past a real pass: same head, but the evidence changed after it. */
async function gateWithOlderPass(t: TestContext) {
  const policy = { minimumReviews: 1, requestedBy: 'human-gate' as const };
  const fixture = await gateFixture(t, policy, 'new', 'new');
  const { run, decision, newHead, refresh, workerArtifacts } = fixture;
  const evidence = path.join(workerArtifacts, 'evidence-manifest.json');
  await mkdir(workerArtifacts, { recursive: true });
  await writeFile(evidence, '{"version":1,"summary":"reviewed evidence"}');
  // A real pass: the reviewer was given these inputs, at this head, for an older package.
  assert.ok(await readReviewedInputs(getRun(run.id)!), 'the slot must report its reviewed inputs');
  await noteReviewInputsAtLaunch(run.id);
  await recordReviewedInputs(run.id);
  const publishGate = getRun(run.id)!.engineState!.publishGate!;
  updateRun(run.id, {
    engineState: {
      ...getRun(run.id)!.engineState,
      publishGate: {
        ...publishGate,
        reviews: publishGate.reviews!.map((review) => ({
          ...review,
          reviewedHeadSha: newHead,
          reviewedPackageInputHash: 'older-package-input',
          reviewedReviewSubjectHash: 'older-review-subject',
        })),
      },
    },
  });
  await writeFile(evidence, '{"version":1,"summary":"evidence recorded after the review"}');
  await refresh();
  return { ...fixture, policy, refreshed: card(run.id, decision.id) };
}

test('a pass at the current head bound to an older package input leaves the refreshed gate not-ready', async (t) => {
  const { newHead, policy, refreshed } = await gateWithOlderPass(t);
  const payload = refreshed.payload as ReadyGatePayload;
  assert.equal(payload.prPackage?.headSha, newHead);
  assert.deepEqual(payload.prPackage?.reviewPolicy, policy);
  assert.equal(payload.gateReadiness?.state, 'not-ready');
  assert.deepEqual(
    refreshed.actions.map(({ id }) => id),
    ['hold', 'request-review'],
  );
  assert.deepEqual(
    payload.gateReadiness?.reasons.map(({ code }) => code),
    ['review-inputs-awaiting-review'],
  );
});

test('a re-review at the unchanged input certifies that gate', async (t) => {
  const { run, refreshed } = await gateWithOlderPass(t);
  const { prPackage } = refreshed.payload as ReadyGatePayload;
  // What a reviewer's launch and pass record.
  await noteReviewInputsAtLaunch(run.id);
  const publishGate = getRun(run.id)!.engineState!.publishGate!;
  updateRun(run.id, {
    engineState: {
      ...getRun(run.id)!.engineState,
      publishGate: {
        ...publishGate,
        reviews: [
          ...publishGate.reviews!,
          {
            ...stampPublishGateReviewStatusForPackage(certifyingReview(prPackage!), prPackage!),
            id: 'review-2',
            reviewerSessionId: 'session-2',
            loopNumber: 2,
            artifactPaths: [RESULT],
          },
        ],
      },
    },
  });
  await recordReviewedInputs(run.id);
  // The review done, the gate presents itself again, on the same package.
  const reentry = getRun(run.id)!;
  supersedeStaleHumanGateDecisions(reentry.decisions);
  updateRun(run.id, {
    decisions: reentry.decisions,
    steps: reentry.steps.map((step) =>
      step.name === 'human-gate' ? { ...step, status: 'running' as const } : step,
    ),
  });
  const presented = new Promise<void>((resolve) =>
    setEngineDecisionRuntime({
      broadcast: (event) => {
        if (event === Events.RUN_DECISION_NEW) resolve();
      },
      stepToStatus: { 'human-gate': 'human-gating' },
    }),
  );
  t.after(() => setEngineDecisionRuntime({ broadcast: () => {}, stepToStatus: {} }));
  const gate = executeReadyGate(run.id, {
    ensurePackage: async () => prPackage!,
    readProgress: async () => ({ kind: 'idle' }),
  });
  await presented;
  const presentedAgain = getRun(run.id)!.decisions.find((entry) => !entry.resolvedAt)!;
  assert.equal((presentedAgain.payload as ReadyGatePayload).gateReadiness?.state, 'ready');
  assert.ok(
    presentedAgain.actions.some(({ id }) => id === APPROVE_PUBLISH_ACTION),
    'the re-review certifies the gate',
  );
  await resolveApproval(run.id, presentedAgain);
  assert.equal(await gate, APPROVE_PUBLISH_ACTION);
});
