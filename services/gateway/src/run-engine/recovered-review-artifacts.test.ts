import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';

import type { AgentContext, ReviewStatus, WorkerSignal } from '@farmslot/protocol';

await import('../runtime/mock-pty.test-support.js');
const { recoverInflightPublicationReviews } = await import('./recover-inflight-reviews.js');
const { collectRunGateReadiness, gateActionsForReadiness } =
  await import('./gate-prerequisites.js');
const { reviewResultArtifactPath } = await import('../review/terminal-result.js');
const { createRun, getRun, updateRun } = await import('../runs/store.js');
const { makeReadyGatePackage, deleteTestRunIfPresent } = await import('./test-fixtures.js');
const { makeVars } = await import('../runners/test-fixtures.js');

async function fixture(t: TestContext, scenario = 'matching') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recovered-review-artifacts-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', [
    '-C',
    root,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--allow-empty',
    '-qm',
    'fixture',
  ]);
  const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const startedAt = '2026-10-16T01:33:44.793Z';
  const completedAt = '2026-10-16T01:39:26.860Z';
  const taskDir = path.join(root, 'task');
  const snapshot = {
    source: 'local-git' as const,
    headSha: head,
    baseSha: 'b'.repeat(40),
    baseRef: 'origin/main',
    diffHash: 'a'.repeat(64),
    diffPath: 'artifacts/pipeline-review-loop-1/review.diff',
    capturedAt: startedAt,
  };
  const prepared = makeReadyGatePackage({
    headSha: head,
    reviewSnapshot: snapshot,
    reviewSubjectHash: scenario === 'changed-subject' ? 'new-subject' : 'reviewed-subject',
    reviewPolicy: { minimumReviews: 1, requestedBy: 'dispatch' },
  });
  const run = createRun({
    flowType: 'dev',
    project: 'generic-project',
    ticketOrPr: 'TEST-1',
    slotId: 'fixture-slot',
  });
  t.after(() => deleteTestRunIfPresent(run.id));
  const ctx: AgentContext = {
    id: 'rev-fixture',
    role: 'review',
    label: 'Fixture reviewer',
    status: 'complete',
    runId: run.id,
    slotId: 'fixture-slot',
    runner: 'claude',
    model: 'opus',
    runnerSessionId: 'reviewer-session',
    reviewId: 'pipeline-review-fixture',
    artifactScope: 'review-2',
    reviewLoopNumber: 1,
    startedAt,
    attemptStartedAt: startedAt,
    completedAt,
    updatedAt: completedAt,
    lastSignalAt: completedAt,
    signalAttemptId: 'attempt-1',
    taskFile: 'task/REVIEW.rev-fixture.md',
    signalFile: 'task/REVIEW.rev-fixture-SIGNAL.json',
    reviewResultFile: 'artifacts/review-result.rev-fixture.json',
  };
  const existing: ReviewStatus = {
    id: 'review-2',
    source: 'dispatch',
    mode: 'cold',
    loopNumber: 2,
    reviewerSessionId: scenario === 'foreign-session' ? 'different-session' : ctx.runnerSessionId,
    verdict: 'pass',
    unresolvedCount: 0,
    startedAt,
    completedAt,
    reviewedHeadSha: head,
    reviewedPackageInputHash: 'original-input-hash',
    reviewedReviewSubjectHash: 'reviewed-subject',
    retryCount: 0,
    maxRetries: 3,
    artifactPaths: ['artifacts/review-2.json', 'artifacts/review-2.md'],
    attempts: [
      { mode: 'cold', loopNumber: 1, verdict: 'pass', unresolvedCount: 0, startedAt, completedAt },
    ],
  };
  await mkdir(path.join(root, 'gateway/artifacts'), { recursive: true });
  await mkdir(path.join(taskDir, 'artifacts/pipeline-review-loop-1'), { recursive: true });
  await mkdir(path.join(taskDir, 'artifacts/pipeline-review-loop-2'), { recursive: true });
  await writeFile(
    path.join(taskDir, 'REVIEW.rev-fixture.md'),
    '# Original completed reviewer task\n',
  );
  const signal: WorkerSignal = {
    status: 'complete',
    timestamp: completedAt,
    attemptId: scenario === 'wrong-attempt' ? 'other-attempt' : 'attempt-1',
  };
  await writeFile(path.join(root, ctx.signalFile!), JSON.stringify(signal));
  const raw = '{"schemaVersion":1,"verdict":"pass","issues":[]}\n';
  await writeFile(path.join(taskDir, ctx.reviewResultFile!), raw);
  await writeFile(
    path.join(taskDir, 'artifacts/review-feedback.rev-fixture.md'),
    'Passed original review.\n',
  );
  if (scenario !== 'missing-snapshot')
    await writeFile(
      path.join(taskDir, 'artifacts/pipeline-review-loop-1/review-diff-stat.json'),
      JSON.stringify({
        ...snapshot,
        ...(scenario === 'wrong-head' ? { headSha: 'c'.repeat(40) } : {}),
        ...(scenario === 'changed-diff' ? { diffHash: 'd'.repeat(64) } : {}),
      }),
    );
  await writeFile(
    path.join(taskDir, 'artifacts/pipeline-review-loop-1/review.diff'),
    'Original reviewed diff\n',
  );
  // A later loop exists but belongs to an older head; recovery must use the recorded loop.
  await writeFile(
    path.join(taskDir, 'artifacts/pipeline-review-loop-2/review-diff-stat.json'),
    JSON.stringify({ ...snapshot, headSha: 'c'.repeat(40) }),
  );
  updateRun(run.id, {
    status: 'blocked',
    taskFile: path.join(root, 'gateway/TASK.md'),
    agentContexts: [ctx],
    engineState: {
      publishGate: {
        packageHash: prepared.packageHash,
        reviewPolicy: prepared.reviewPolicy,
        reviews: [existing],
      },
    },
  });
  const vars = { ...makeVars(), host: 'localhost', repo: root, remoteRepo: root };
  let captureCalls = 0;
  let failCapture = scenario === 'capture-error';
  const recover = () =>
    recoverInflightPublicationReviews(run.id, 'fixture-slot', {
      captureArtifacts: async () => {
        captureCalls++;
        assert.equal(
          getRun(run.id)!.engineState!.publishGate!.reviews![0].reviewSnapshot,
          undefined,
        );
        if (failCapture) {
          failCapture = false;
          throw new Error('Fixture capture unavailable');
        }
      },
      readers: {
        slot: async () => vars,
        config: async () => ({ enabled: true, max_retries: 3 }),
        package: async () => prepared,
      },
    });
  const readiness = () =>
    collectRunGateReadiness(getRun(run.id)!, prepared, {
      deterministic: async () => {},
      acceptance: async () => ({ criteria: [], ledger: null, issues: [] }),
      progress: async () => ({ kind: 'idle' }),
      selectedEvidence: async () => {},
      reviewedInputsAwaitingReview: async () => null,
      reviewResult: async (_run, relative) => readFile(path.join(taskDir, relative), 'utf8'),
    });
  return {
    run,
    ctx,
    existing,
    raw,
    taskDir,
    prepared,
    recover,
    readiness,
    captureCalls: () => captureCalls,
  };
}

test('an ingested PASS regains its launch snapshot and exact structured result without a new review', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.readiness()).state, 'not-ready');
  assert.deepEqual((await f.recover()).recoveredIds, ['review-2']);
  const after = getRun(f.run.id)!;
  const reviews = after.engineState!.publishGate!.reviews!;
  assert.equal(reviews.length, 1);
  assert.equal(f.captureCalls(), 1);
  const repaired = reviews[0];
  assert.equal(repaired.attempts?.length, 1);
  for (const key of [
    'id',
    'verdict',
    'unresolvedCount',
    'retryCount',
    'maxRetries',
    'startedAt',
    'completedAt',
    'reviewerSessionId',
    'reviewedHeadSha',
    'reviewedPackageInputHash',
    'reviewedReviewSubjectHash',
  ] as const)
    assert.equal(repaired[key], f.existing[key], key);
  assert.equal(repaired.reviewSnapshot?.headSha, f.prepared.headSha);
  assert.equal(repaired.reviewSnapshot?.diffHash, f.prepared.reviewSnapshot?.diffHash);
  const result = reviewResultArtifactPath(repaired);
  assert.equal(result, 'artifacts/review-2/review-loop-1/review-result.json');
  assert.equal(await readFile(path.join(f.taskDir, result), 'utf8'), f.raw);
  assert.equal(await readFile(path.join(f.taskDir, f.ctx.reviewResultFile!), 'utf8'), f.raw);
  assert.equal(after.agentContexts?.[0].completedAt, f.ctx.completedAt);
  const ready = await f.readiness();
  assert.equal(ready.state, 'ready');
  assert.deepEqual(gateActionsForReadiness([{ id: 'approve-publish' }, { id: 'hold' }], ready), [
    { id: 'approve-publish' },
    { id: 'hold' },
  ]);
  assert.deepEqual((await f.recover()).recoveredIds, []);
  assert.equal(f.captureCalls(), 1);
  assert.deepEqual(getRun(f.run.id)!.engineState!.publishGate!.reviews, reviews);
});

test('failed artifact capture leaves the same review repairable without spending another attempt', async (t) => {
  const f = await fixture(t, 'capture-error');
  assert.deepEqual((await f.recover()).recoveredIds, []);
  assert.deepEqual(getRun(f.run.id)!.engineState!.publishGate!.reviews, [f.existing]);
  assert.deepEqual((await f.recover()).recoveredIds, ['review-2']);
  assert.equal(f.captureCalls(), 2);
  assert.equal(getRun(f.run.id)!.engineState!.publishGate!.reviews![0].attempts?.length, 1);
  assert.equal((await f.readiness()).state, 'ready');
});

for (const scenario of ['missing-snapshot', 'wrong-head', 'wrong-attempt', 'foreign-session']) {
  test(`recovered verdict refuses ${scenario} without replacing its recorded attempt`, async (t) => {
    const f = await fixture(t, scenario);
    assert.deepEqual((await f.recover()).recoveredIds, [], scenario);
    assert.deepEqual(getRun(f.run.id)!.engineState!.publishGate!.reviews, [f.existing]);
    assert.equal((await f.readiness()).state, 'not-ready');
  });
}

for (const scenario of ['changed-subject', 'changed-diff']) {
  test(`metadata repair preserves ${scenario} freshness refusal`, async (t) => {
    const f = await fixture(t, scenario);
    assert.deepEqual((await f.recover()).recoveredIds, ['review-2']);
    assert.equal(getRun(f.run.id)!.engineState!.publishGate!.reviews!.length, 1);
    assert.equal((await f.readiness()).state, 'not-ready', scenario);
  });
}
