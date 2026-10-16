import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  type AgentContext,
  isRecipeRepairScope,
  type RecipeClaimVerdict,
  recipeRepairId,
  type RecipeRepairScope,
  recipeRepairScopeDigest,
  recordedEvidenceClosureIdentity,
  type RecordedEvidencePackageInput,
  type ReviewStatus,
  type Run,
  type VisualRepairRecord,
} from '@farmslot/protocol';

import { repairFeedbackCandidates } from '../intelligence/feedback-candidates.js';
import { computeReadyGatePackageHash } from '../run-completion/ready-gate-package.js';

import { stampPublishGateReviewStatusForPackage } from './gate-policy.js';
import { makeReadyGatePackage, makeRun } from './test-fixtures.js';
import {
  activeVisualRepair,
  reserveVisualRepair,
  type VisualRepairAdmission,
  visualRepairEvidenceReasons,
  visualRepairIssues,
} from './visual-repair.js';

const sha = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`;

function recorded(
  recipeRunId: string,
  criteria: Array<[string, RecipeClaimVerdict]>,
): RecordedEvidencePackageInput {
  return {
    summary: { recipeRunId },
    claims: {
      schemaVersion: 2,
      recipeRunId,
      criteria: criteria.map(([id, verdict]) => ({
        id,
        text: id,
        kind: 'acceptance',
        proofMode: 'visual',
        verdict,
        recipeNodes: [],
        assertionIndices: [],
        evidence: [],
        moments: [],
      })),
      recording: { status: 'complete', segments: [] },
    },
    artifactPaths: ['summary.json'],
    artifactDigests: { 'summary.json': sha(recipeRunId) },
    timelines: {},
  };
}

const original = recorded('original', [
  ['AC-1', 'awaiting-review'],
  ['AC-2', 'awaiting-review'],
]);
const closure = recordedEvidenceClosureIdentity(original);
const head = 'e'.repeat(40);
const unhashed = makeReadyGatePackage({
  headSha: head,
  reviewSubjectHash: 'subject',
  reviewSnapshot: {
    source: 'local-git',
    baseRef: 'origin/main',
    baseSha: 'd'.repeat(40),
    headSha: head,
    diffHash: 'diff',
    diffStat: { files: 1, additions: 1, deletions: 0 },
    capturedAt: '2026-10-16T00:00:00.000Z',
  },
});
// The scope binds the gate's own package identity, in its production format.
const pkg = { ...unhashed, packageHash: computeReadyGatePackageHash(unhashed) };
const packageHash = pkg.packageHash;
const scope: RecipeRepairScope = {
  schemaVersion: 1,
  repairId: recipeRepairId({ runId: 'run-1', packageHash, receiptIds: ['receipt-2'] }),
  runId: 'run-1',
  generation: 0,
  decisionId: 'gate',
  packageHash,
  packageHeadSha: 'c'.repeat(40),
  reviewBaseSha: 'd'.repeat(40),
  reviewId: 'review-1',
  workerContextId: 'run-1:dev',
  repairRecipe: 'recipes/visual-repair.json',
  claims: [
    { id: 'AC-1', claim: 'AC-1' },
    { id: 'AC-2', claim: 'AC-2' },
  ],
  sources: [
    {
      recipeRunId: 'original',
      closureIdentity: closure,
      artifactRoot: 'artifacts/recipe-runs/original',
      headSha: 'c'.repeat(40),
    },
  ],
  retained: [{ claimId: 'AC-1', recipeRunId: 'original' }],
  rejected: [
    {
      claimId: 'AC-2',
      proofMode: 'visual',
      receiptId: 'receipt-2',
      reason: 'The chart is blank.',
      recipeRunId: 'original',
      closureIdentity: closure,
      reviewedFiles: [{ path: 'stills/chart.png', digest: sha('png') }],
      moments: [{ recipeRunId: 'original', videoDigest: sha('video'), traceIndex: 4 }],
    },
  ],
};
const fresh: RecordedEvidencePackageInput = {
  ...recorded('fresh', [
    ['AC-1', 'missing'],
    ['AC-2', 'awaiting-review'],
  ]),
  comparisonDependencies: [{ artifactRoot: 'comparison-dependencies/original', input: original }],
  repair: {
    scope,
    selection: {
      schemaVersion: 1,
      repairId: scope.repairId,
      scopeDigest: recipeRepairScopeDigest(scope),
      recipeRunId: 'fresh',
      claims: [
        { claimId: 'AC-1', source: 'retained', recipeRunId: 'original', closureIdentity: closure },
        { claimId: 'AC-2', source: 'fresh' },
      ],
    },
  },
};
const review = (id: string): ReviewStatus =>
  stampPublishGateReviewStatusForPackage(
    {
      id,
      mode: 'cold',
      loopNumber: 1,
      verdict: 'pass',
      unresolvedCount: 0,
      reviewerSessionId: `session-${id}`,
      reviewSnapshot: pkg.reviewSnapshot,
      retryCount: 1,
      maxRetries: 2,
    },
    pkg,
  );
const reviewer = (id: string, reviewId: string): AgentContext => ({
  id,
  role: 'review',
  label: id,
  status: 'complete',
  slotId: 'slot-1',
  runId: 'run-1',
  reviewId,
});
const binding = {
  contextId: 'ctx-1',
  executionNodeId: 'node',
  ownerPrincipalId: 'owner',
  sessionId: 'session',
  generation: 'generation',
  leaseId: 'lease',
  commandId: 'command',
};
const row = (reviewContextId: string, unaffected: boolean, rowHead = head) => ({
  claimId: 'AC-1',
  recipeRunId: 'original',
  closureIdentity: closure,
  unaffected,
  reason: unaffected ? 'The diff only touches the chart.' : 'The header component changed.',
  headSha: rowHead,
  reviewContextId,
  binding: { ...binding, contextId: reviewContextId },
  recordedAt: '2026-10-16T00:00:00.000Z',
});
const record = (overrides: Partial<VisualRepairRecord> = {}): VisualRepairRecord => ({
  repairId: scope.repairId,
  scope,
  scopeDigest: recipeRepairScopeDigest(scope),
  decisionId: 'gate',
  packageHash,
  reviewId: 'review-1',
  status: 'completed',
  reservedRetryCount: 1,
  reservedAt: '2026-10-16T00:00:00.000Z',
  rejected: [{ claimId: 'AC-2', receiptId: 'receipt-2', reason: 'The chart is blank.' }],
  ...overrides,
});
function repairRun(repairs: VisualRepairRecord[], reviewers: string[] = ['review-1']): Run {
  const run = makeRun({
    id: 'run-1',
    engineState: { publishGate: { reviews: reviewers.map(review), visualRepairs: repairs } },
  });
  run.agentContexts = reviewers.map((id, index) => reviewer(`ctx-${index + 1}`, id));
  return run;
}
const codes = (run: Run, prepared = pkg) =>
  visualRepairEvidenceReasons(run, [fresh], prepared).map(({ code }) => code);

test('repair evidence needs an authorised scope at the frozen review base', () => {
  assert.ok(isRecipeRepairScope(scope), 'a scope bound to a real gate package is valid');
  assert.deepEqual(codes(repairRun([])), ['evidence-repair-unbound']);
  assert.deepEqual(
    codes(repairRun([record({ applicability: [row('ctx-1', true)] })]), {
      ...pkg,
      reviewSnapshot: { ...pkg.reviewSnapshot!, baseSha: 'f'.repeat(40) },
    }),
    ['evidence-repair-scope-changed'],
  );
});

test('retained proof needs every certifying reviewer to classify it unaffected at the current head', () => {
  assert.deepEqual(codes(repairRun([record({ applicability: [row('ctx-1', true)] })])), []);
  // No classification, an older head, or any affected row requires fresh proof.
  for (const applicability of [
    [],
    [row('ctx-1', true, 'a'.repeat(40))],
    [row('ctx-1', true), row('ctx-1', false)],
  ]) {
    const reasons = visualRepairEvidenceReasons(
      repairRun([record({ applicability })]),
      [fresh],
      pkg,
    );
    assert.deepEqual(
      reasons.map(({ code, reference }) => [code, reference]),
      [['evidence-repair-applicability-missing', 'AC-1']],
    );
  }
  // Two required reviewers must agree; one silent reviewer blocks.
  const twoReviewers = repairRun(
    [record({ applicability: [row('ctx-1', true)] })],
    ['review-1', 'review-2'],
  );
  assert.deepEqual(codes(twoReviewers), ['evidence-repair-applicability-missing']);
  assert.deepEqual(
    codes(
      repairRun(
        [record({ applicability: [row('ctx-1', true), row('ctx-2', true)] })],
        ['review-1', 'review-2'],
      ),
    ),
    [],
  );
});

test('the reservation is one persisted increment of the named loop and an identical retry reuses it', () => {
  const run = makeRun({
    id: 'run-1',
    engineState: { publishGate: { reviews: [{ ...review('review-1'), retryCount: 0 }] } },
  });
  const admission: VisualRepairAdmission = {
    scope,
    review: run.engineState!.publishGate!.reviews![0]!,
    issues: [
      {
        ...scope.rejected[0]!,
        reviewer: 'Arthur',
      },
    ],
  };
  const reserved = reserveVisualRepair(run, admission, '2026-10-16T01:00:00.000Z');
  assert.equal(reserved.publishGate!.reviews![0]!.retryCount, 1);
  const [repair] = reserved.publishGate!.visualRepairs!;
  assert.equal(repair!.status, 'reserved');
  assert.equal(repair!.reservedRetryCount, 1);
  assert.equal(repair!.scopeDigest, recipeRepairScopeDigest(scope));
  assert.deepEqual(repair!.rejected, [
    { claimId: 'AC-2', receiptId: 'receipt-2', reason: 'The chart is blank.', reviewer: 'Arthur' },
  ]);
  const retried = makeRun({ id: 'run-1', engineState: reserved });
  assert.equal(activeVisualRepair(retried)?.repairId, scope.repairId);
  assert.equal(reserveVisualRepair(retried, { ...admission, reuse: repair }), retried.engineState);
});

test('the existing REVIEW-FIX renderer receives the repair contract and each rejected criterion', () => {
  const [contract, issue] = visualRepairIssues(scope, 'tasks/dev/PROOF-1');
  assert.equal(contract!.file, 'artifacts/visual-repair-scope.json');
  assert.match(contract!.description, /recipes\/visual-repair\.json/u);
  assert.match(
    contract!.description,
    /RECIPE_TASK_DIR="\$\(cd tasks\/dev\/PROOF-1 && pwd\)" farmslot recipe run tasks\/dev\/PROOF-1\/recipes\/visual-repair\.json/u,
  );
  assert.match(contract!.description, /Leave the main task recipe unchanged/u);
  assert.equal(issue!.file, 'artifacts/recipe-runs/original/stills/chart.png');
  assert.equal(
    issue!.description,
    'AC-2 Issue (visual proof required): The chart is blank. Rejected moments: trace 4.',
  );
});

test('Send back reasons become learning candidates bound to their receipt and repair, without a PR', () => {
  const run = repairRun([record()]);
  run.visualJudgmentReceipts = [
    {
      id: 'receipt-2',
      runId: 'run-1',
      snapshotIdentity: closure,
      closureIdentity: closure,
      recipeRunId: 'original',
      claimId: 'AC-2',
      verdict: 'rejected',
      reason: 'The chart is blank.',
      moments: [],
      approver: { principalId: 'person', credentialId: 'credential', displayName: 'Arthur' },
      judgedAt: '2026-10-16T00:00:00.000Z',
    },
  ];
  const [candidate] = repairFeedbackCandidates(run);
  assert.equal(candidate!.provider, 'farmslot');
  assert.equal(candidate!.kind, 'visual-repair');
  assert.equal(
    candidate!.sourceKey,
    `farmslot/run/run-1/repair/${scope.repairId}:visual-repair:receipt-2`,
  );
  assert.equal(candidate!.authorKind, 'human');
  assert.equal(candidate!.excerpt, 'AC-2: The chart is blank.');
  assert.equal(candidate!.resolution.state, 'fixed');
  assert.equal(
    repairFeedbackCandidates(repairRun([record({ status: 'reserved' })]))[0]!.resolution.state,
    'open',
  );
});
