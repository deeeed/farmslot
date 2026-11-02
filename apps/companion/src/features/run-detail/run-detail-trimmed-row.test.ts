/**
 * Run Detail's first render from a run.list row, trimmed by the `trimRunForList` the gateway's
 * run.list uses.
 *
 * run.list leaves out every decision payload value over 2 KB and the output manifest. Run
 * Detail draws that row while run.get loads, so each helper it calls on first render (directly
 * or through its panels) must take the row without throwing, and must report what the row left
 * out as not loaded rather than as zero.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createEvidenceReviewModel, runEvidencePending } from '@farmslot/adapter-sdk/evidence';
import {
  cancelledRunSlotChoices,
  deriveRunLifecycleView,
  extractRunArtifactManifest,
  isSlotFreedByPark,
  liveGateParkView,
  reviewChainForRun,
  type ReviewLineComment,
  type Run,
  runHasTrimmedDetail,
  savedReviewView,
  trimRunForList,
} from '@farmslot/protocol';
import {
  humanGateBlockingReason,
  pendingOutputReview,
  reviewHistoryArtifactPaths,
  reviewHistoryIdentity,
  reviewHistoryView,
  runActivityView,
  runResultsSummary,
  runTerminalView,
} from '@farmslot/review-dispatch';

import { openHumanGateDecision } from '../../lib/gate-review';
import { collectRunInteractivePacketArtifacts } from '../../lib/interactive-operator-packets';
import {
  hasRunWorkspaceDiff,
  runWorkspaceDiffValue,
  selectSlotCompareTarget,
  summarizeSlotWorkspaceGates,
  summarizeSlotWorkspaceRetro,
} from '../../lib/slot-workspace';
import {
  effectiveTaskProgressForRun,
  fallbackTaskProgressSummary,
  isWorkerProgressActive,
  taskProgressRequestForRun,
} from '../../lib/task-progress';
import { workspaceDecisionKind } from '../../lib/workspace-decisions';

import { runEvidenceQuery } from './run-evidence';

/** Five findings of about 600 bytes each: over run.list's 2 KB limit for one payload value. */
const findings: ReviewLineComment[] = Array.from({ length: 5 }, (_, index) => ({
  path: `src/feature/module-${index}.ts`,
  line: 10 + index,
  severity: 'P2',
  body: `[P2] Finding ${index}: ${'the handler drops the error and retries forever. '.repeat(11)}`,
}));

/** A finished repeat review: its result lives only in the posting gate's payload. */
const reviewRun: Run = {
  id: 'run-review',
  familyId: 'family-review',
  lane: 'production',
  flowType: 'review-pr',
  status: 'done',
  project: 'example-mobile',
  ticketOrPr: 'PR-12',
  summary: 'Review PR 12',
  slotId: 'slot-1',
  branch: 'review/pr-12',
  taskFile: '/repo/TASK.md',
  steps: [
    { name: 'review', status: 'done' },
    { name: 'monitor', status: 'done' },
  ],
  decisions: [
    {
      id: 'decision-review',
      type: 'engine_review_posting',
      title: 'Post the review',
      description: 'Review ready to post',
      actions: [{ id: 'post', label: 'Post', style: 'primary' }],
      createdAt: '2026-11-02T01:00:00.000Z',
      resolvedAt: '2026-11-02T01:05:00.000Z',
      resolvedAction: 'post',
      payload: {
        kind: 'review',
        prNumber: 12,
        repo: 'acme/app',
        recommendation: 'REQUEST_CHANGES',
        reviewMd: 'Five findings.',
        lineComments: findings,
        artifactManifest: [{ path: 'artifacts/review.md', purpose: 'review' }],
      },
    },
  ],
  output: {
    capturedAt: '2026-11-02T01:04:00.000Z',
    workerFinished: true,
    manifestDigest: 'digest-1',
    artifactManifest: [
      { path: 'artifacts/review.md', purpose: 'review' },
      { path: 'artifacts/before.png', purpose: 'screenshot' },
      { path: 'artifacts/after.png', purpose: 'screenshot' },
    ],
  },
  repeatReviewContext: {
    version: 1,
    chainId: 'chain-12',
    generation: 2,
    priorRunId: 'run-review-1',
    priorFamilyId: 'family-review-1',
    repository: 'acme/app',
    prNumber: 12,
    currentHeadSha: 'head-2',
    verdict: 'REQUEST_CHANGES',
    unresolvedFindings: [],
    artifactRefs: [],
    farmslotEvidenceRefs: [],
    mode: 'cold',
    validationDepth: 'static-code',
  },
  metrics: { nudgeCount: 0, model: null, runner: null },
  createdAt: '2026-11-02T00:00:00.000Z',
  updatedAt: '2026-11-02T01:05:00.000Z',
};

/** Every helper Run Detail and its panels call with the run on first render. */
function firstRender(run: Run) {
  const manifest = extractRunArtifactManifest(run);
  const gates = summarizeSlotWorkspaceGates(run);
  const chain = reviewChainForRun(run);
  const evidenceModel = createEvidenceReviewModel({
    context: 'run-detail',
    reportSnapshot: pendingOutputReview(run)?.payload,
    artifacts: manifest,
    evidencePending: runEvidencePending(run),
  });
  runEvidenceQuery(run.id, run, null);
  taskProgressRequestForRun(run);
  runResultsSummary(run, manifest.length);
  effectiveTaskProgressForRun(run, null);
  isWorkerProgressActive(run);
  fallbackTaskProgressSummary(run);
  runWorkspaceDiffValue(run, gates[0] ?? null);
  hasRunWorkspaceDiff(run, gates[0] ?? null);
  summarizeSlotWorkspaceRetro(run);
  selectSlotCompareTarget({
    runArtifacts: manifest,
    recipeRuns: [],
    selectedRecipeRunId: null,
    evidenceModel,
  });
  deriveRunLifecycleView(run);
  cancelledRunSlotChoices(run, []);
  openHumanGateDecision(run);
  run.decisions.forEach(workspaceDecisionKind);
  humanGateBlockingReason(run);
  runTerminalView(run);
  runActivityView(run);
  isSlotFreedByPark(run);
  liveGateParkView(run);
  reviewHistoryView(run, {}, chain);
  reviewHistoryIdentity(run);
  reviewHistoryArtifactPaths(run);
  collectRunInteractivePacketArtifacts(run);
  return { gates, chain, saved: savedReviewView(run) };
}

const metric = (gates: ReturnType<typeof summarizeSlotWorkspaceGates>, label: string) =>
  gates[0]?.metrics.find((entry) => entry.label === label)?.value;

test('the gateway trims this review row the way run.list sends it', () => {
  const row = trimRunForList(reviewRun);
  assert.deepEqual(row.decisions[0]?.payloadTrimmed, ['lineComments']);
  assert.equal(row.output?.artifactManifestOmitted, true);
  assert.equal(runHasTrimmedDetail(row), true);
  assert.equal(runHasTrimmedDetail(reviewRun), false);
});

test('a trimmed review row renders, and what it left out reads as not loaded', () => {
  const { gates, chain, saved } = firstRender(trimRunForList(reviewRun));
  assert.equal(metric(gates, 'Comments'), 'not loaded');
  assert.equal(metric(gates, 'Evidence'), 'not loaded');
  assert.equal(chain.at(-1)?.unresolvedCount, null);
  assert.equal(saved?.verdict, 'REQUEST_CHANGES');
});

test('the full run.get copy still counts what the row left out', () => {
  const { gates, chain } = firstRender(reviewRun);
  assert.equal(metric(gates, 'Comments'), '5');
  assert.equal(metric(gates, 'Evidence'), '1');
  assert.equal(chain.at(-1)?.unresolvedCount, 5);
});
