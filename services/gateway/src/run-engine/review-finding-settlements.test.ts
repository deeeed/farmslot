import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { deriveReviewedRecipeClaims } from '@farmslot/adapter-sdk/evidence';
import {
  type AgentContext,
  type RecipeVisualJudgmentReceipt,
  recordedEvidenceClosureIdentity,
  type RecordedEvidencePackageInput,
  reviewedVisualFiles,
  type ReviewStatus,
  type Run,
} from '@farmslot/protocol';
import { publicationReviewBlockingReason } from '@farmslot/review-dispatch';

await import('../runtime/mock-pty.test-support.js');
const { assertPublicationReviewPolicySatisfied } = await import('./gate-policy.js');
const { restampReviewsForRefreshedPackage } = await import('./publish-package-refresh.js');
const { projectClaimFindingSettlements } = await import('./review-finding-settlements.js');
const { makeRun, makeReadyGatePackage } = await import('./test-fixtures.js');
const { computeReadyGateReviewSubjectHash } =
  await import('../run-completion/ready-gate-package.js');
const { commitRunVisualJudgment, createRun, getRun, updateRun } = await import('../runs/store.js');
const { deleteTestRunIfPresent } = await import('./test-fixtures.js');
const { collectRunGateAssessment } = await import('./gate-prerequisites.js');

async function fixture() {
  const { input }: { input: RecordedEvidencePackageInput } = JSON.parse(
    await readFile(
      new URL(
        '../../../../packages/recipe-runner/test/fixtures/visual-review-package.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  assert.ok(input.claims);
  const claim = deriveReviewedRecipeClaims(input).find((candidate) => candidate.id === 'check-1');
  assert.ok(claim);
  const headSha = 'a'.repeat(40);
  const pkg = makeReadyGatePackage({
    headSha,
    reviewPolicy: { minimumReviews: 1, requestedBy: 'dispatch' },
  });
  pkg.reviewSubjectHash = computeReadyGateReviewSubjectHash(pkg);
  const review: ReviewStatus = {
    id: 'pipeline-review',
    source: 'pipeline',
    mode: 'cold',
    loopNumber: 1,
    reviewerSessionId: 'reviewer-session',
    verdict: 'issues',
    unresolvedCount: 1,
    artifactPaths: ['artifacts/pipeline-review-loop-1/review-result.json'],
    reviewSnapshot: pkg.reviewSnapshot,
    issues: [
      {
        file: 'temp/tasks/fix/example/artifacts/evidence-manifest.json',
        line: 33,
        description:
          'check-1 remains unproven: the resting order is visible, but no position. Supply proof or resolve the criterion through an authorized gate decision.',
      },
    ],
  };
  const receipt: RecipeVisualJudgmentReceipt = {
    id: 'person-confirmation',
    runId: 'run-1',
    claimId: claim.id,
    recipeRunId: input.claims.recipeRunId,
    closureIdentity: recordedEvidenceClosureIdentity(input),
    snapshotIdentity: 'captured-selection',
    verdict: 'confirmed',
    kind: 'person-reviewed',
    reviewerSubjectKind: 'person',
    precedence: 'person-first-v1',
    moments: claim.moments,
    reviewedFiles: reviewedVisualFiles(input, claim.id),
    judgedAt: '2026-10-21T08:21:52Z',
    approver: { principalId: 'person', displayName: 'Reviewer', personSessionId: 'person-session' },
  };
  const binding = {
    contextId: 'native-reviewer',
    executionNodeId: 'node',
    ownerPrincipalId: 'owner',
    sessionId: 'native-session',
    generation: 'generation',
    leaseId: 'lease',
    commandId: 'command',
  };
  const context: AgentContext = {
    id: binding.contextId,
    runId: 'run-1',
    slotId: 'slot-1',
    label: 'Review',
    role: 'review',
    status: 'complete',
    reviewId: review.id,
    runnerSessionId: review.reviewerSessionId,
    nativeSession: {
      ...binding,
      stateDirectory: '/tmp/reviewer',
      resultSchema: 'pipeline-visual-judgments-v1',
      closedAt: '2026-10-21T02:52:08Z',
    },
    pipelineVisualReviewResult: {
      headSha,
      binding,
      completedAt: '2026-10-21T02:52:07Z',
      result: {
        schemaVersion: 1,
        recipeRunId: receipt.recipeRunId,
        closureIdentity: receipt.closureIdentity,
        judgments: [
          {
            claimId: claim.id,
            verdict: 'rejected',
            reason: 'Only a resting order is shown.',
            reviewedFiles: receipt.reviewedFiles!,
            moments: claim.moments,
          },
        ],
      },
    },
  };
  const run: Run = {
    ...makeRun({
      id: 'run-1',
      status: 'human-gating',
      engineState: { publishGate: { reviews: [review] } },
    }),
    visualJudgmentReceipts: [receipt],
    agentContexts: [context],
  };
  const sources = [{ input, artifactPrefix: 'artifacts/recipe-runs/proof/' }];
  const project = (current = run, reviews: ReviewStatus[] = [review]) =>
    projectClaimFindingSettlements(current, sources, headSha, reviews, new Set([review.id]));
  return { run, review, receipt, pkg, project, sources, headSha };
}

test('bound person confirmation settles the retained evidence finding and repairs package registration', async () => {
  const f = await fixture();
  const before = structuredClone(f.run);
  const projected = f.project();
  const reviews = restampReviewsForRefreshedPackage(projected.reviews, [f.pkg], f.pkg);
  const current = {
    ...f.run,
    visualJudgmentReceipts: projected.receipts,
    engineState: { ...f.run.engineState, publishGate: { reviews } },
  };
  assert.equal(publicationReviewBlockingReason(current, f.pkg), undefined);
  assert.doesNotThrow(() => assertPublicationReviewPolicySatisfied(current, f.pkg));
  assert.equal(reviews[0].verdict, 'issues');
  assert.deepEqual(reviews[0].issues, f.review.issues);
  assert.equal(projected.receipts[0].settledReviewFindings?.length, 1);
  assert.equal(reviews[0].settledFindings?.[0].receiptId, f.receipt.id);
  assert.deepEqual(f.run, before);
  assert.deepEqual(f.project(current).receipts, projected.receipts);
});

test('code defects remain open even when they cite the confirmed criterion', async () => {
  const f = await fixture();
  const review = {
    ...f.review,
    unresolvedCount: 2,
    issues: [
      ...f.review.issues!,
      { file: 'src/orders.ts', description: 'check-1 submits the wrong order quantity.' },
    ],
  };
  const projected = f.project(f.run, [review]);
  const current = { ...f.run, engineState: { publishGate: { reviews: projected.reviews } } };
  assert.match(publicationReviewBlockingReason(current, f.pkg)!, /1 issue/);
  assert.throws(() => assertPublicationReviewPolicySatisfied(current, f.pkg));
  const mixed = {
    ...f.review,
    issues: [
      {
        ...f.review.issues![0],
        description: 'check-1 is unproven because src/orders.ts submits the wrong quantity.',
      },
    ],
  };
  assert.equal(f.project(f.run, [mixed]).reviews[0].settledFindings, undefined);
});

test('a rejected, foreign-closure or delegated judgment cannot settle the person-only finding', async () => {
  const f = await fixture();
  for (const receipt of [
    {
      ...f.receipt,
      id: 'later-rejection',
      verdict: 'rejected' as const,
      reason: 'The evidence is wrong.',
      judgedAt: '2026-10-21T09:00:00Z',
    },
    { ...f.receipt, closureIdentity: 'another-closure' },
    { ...f.receipt, kind: 'lead-agent-reviewed' as const, reviewerSubjectKind: 'service' as const },
  ]) {
    const projected = f.project({ ...f.run, visualJudgmentReceipts: [receipt] });
    assert.equal(projected.reviews[0].settledFindings, undefined);
  }
  const projected = f.project();
  const later = {
    ...f.receipt,
    id: 'later-rejection',
    verdict: 'rejected' as const,
    reason: 'The evidence is wrong.',
    judgedAt: '2026-10-21T09:00:00Z',
  };
  assert.equal(
    f.project({ ...f.run, visualJudgmentReceipts: [...projected.receipts, later] }).reviews[0]
      .settledFindings,
    undefined,
  );
  const foreign = projectClaimFindingSettlements(
    f.run,
    f.sources,
    'b'.repeat(40),
    [f.review],
    new Set([f.review.id]),
  );
  assert.equal(foreign.reviews[0].settledFindings, undefined);
  assert.equal(
    projectClaimFindingSettlements(f.run, f.sources, f.headSha, [f.review], new Set()).reviews[0]
      .settledFindings,
    undefined,
  );
});

test('settlement appends audit references to the original person receipt without a second judgment', async (t) => {
  const f = await fixture();
  const run = createRun({
    project: 'example-mobile-farm',
    flowType: 'dev',
    ticketOrPr: 'UNIT-CLAIM-SETTLEMENT',
  });
  t.after(() => deleteTestRunIfPresent(run.id));
  const original = { ...f.receipt, runId: run.id };
  await commitRunVisualJudgment(
    run.id,
    () => original,
    () => {},
  );
  const settled = { ...f.project().receipts[0], runId: run.id };
  const commit = () =>
    commitRunVisualJudgment(
      run.id,
      () => settled,
      () => {},
    );
  await commit();
  await commit();
  const saved = getRun(run.id)!.visualJudgmentReceipts!;
  assert.equal(saved.length, 1);
  assert.equal(saved[0].id, original.id);
  assert.equal(saved[0].judgedAt, original.judgedAt);
  assert.deepEqual(saved[0].approver, original.approver);
  assert.deepEqual(saved[0].settledReviewFindings, settled.settledReviewFindings);
  await assert.rejects(
    commitRunVisualJudgment(
      run.id,
      () => ({ ...settled, verdict: 'rejected', reason: 'Rewritten decision' }),
      () => {},
    ),
    /cannot be rewritten/,
  );
  assert.deepEqual(getRun(run.id)!.visualJudgmentReceipts, saved);
});

test('readiness qualifies the original receipt and refuses unqualified settlement decorations', async (t) => {
  const f = await fixture();
  const created = createRun({
    project: 'example-mobile-farm',
    flowType: 'fix-bug',
    ticketOrPr: 'UNIT-SETTLED-GATE',
  });
  t.after(() => deleteTestRunIfPresent(created.id));
  const { runId: _runId, ...receipt } = f.receipt;
  await commitRunVisualJudgment(
    created.id,
    () => ({ ...receipt, runId: created.id }),
    () => {},
  );
  updateRun(created.id, {
    status: 'human-gating',
    agentContexts: f.run.agentContexts!.map((context) => ({ ...context, runId: created.id })),
    engineState: f.run.engineState,
  });
  const current = getRun(created.id)!;
  const projection = f.project(current);
  const reviews = restampReviewsForRefreshedPackage(projection.reviews, [f.pkg], f.pkg);
  updateRun(created.id, { engineState: { publishGate: { reviews } } });
  const input = f.sources[0].input;
  assert.ok(input.claims);
  f.pkg.visualJudgmentReceiptIds = [f.receipt.id];
  const readers = {
    deterministic: async () => {},
    progress: async () => ({ kind: 'idle' as const }),
    acceptance: async () => ({
      criteria: input.claims!.criteria.map(({ id, text }) => ({ id, text })),
      ledger: input.claims!,
      issues: [],
    }),
    recordedEvidence: async () => [input],
    reviewResult: async () =>
      JSON.stringify({ schemaVersion: 1, verdict: 'issues', issues: f.review.issues }),
    selectedEvidence: async () => {},
    publicationSecrets: async () => {},
    reviewedInputsAwaitingReview: async () => null,
  };
  const ready = await collectRunGateAssessment(getRun(created.id)!, f.pkg, readers);
  assert.deepEqual(ready.readiness.reasons, []);
  assert.equal(ready.readiness.state, 'ready');
  const forged = await collectRunGateAssessment(
    { ...getRun(created.id)!, visualJudgmentReceipts: [] },
    f.pkg,
    readers,
  );
  assert(forged.readiness.reasons.some((reason) => reason.code === 'review-fix-required'));
  assert(forged.readiness.reasons.some((reason) => reason.code === 'review-result-required'));
});
