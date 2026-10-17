import assert from 'node:assert/strict';
import test from 'node:test';

import type { AcceptanceCriterionStatus, AcceptanceStatusLedger, Run } from '@farmslot/protocol';

import {
  acceptancePanelPresentation,
  pendingOutputReview,
  runResultsSummary,
} from '../src/run-results.js';

function criterion(overrides: Partial<AcceptanceCriterionStatus> = {}): AcceptanceCriterionStatus {
  return {
    id: 'AC-1',
    text: 'The panel lists every criterion',
    verdict: 'proven',
    evidence: [],
    recipeNodes: [],
    updatedAt: '2026-09-19T10:00:00.000Z',
    ...overrides,
  };
}

function ledger(criteria: AcceptanceCriterionStatus[]): AcceptanceStatusLedger {
  return { schemaVersion: 1, criteria };
}

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run-1',
    familyId: 'family-1',
    lane: 'production',
    flowType: 'fix-bug',
    status: 'done',
    project: 'farmslot-farm',
    ticketOrPr: 'BUG-123',
    slotId: null,
    branch: null,
    taskFile: null,
    steps: [],
    decisions: [],
    metrics: { nudgeCount: 0, runner: 'codex', model: 'gpt-5.4' },
    createdAt: '2026-05-14T00:00:00.000Z',
    updatedAt: '2026-05-14T00:00:00.000Z',
    ...overrides,
  };
}

test('the header separates assessment progress from proven criteria', () => {
  const view = acceptancePanelPresentation(
    ledger([
      criterion({ id: 'AC-1', verdict: 'proven' }),
      criterion({ id: 'AC-2', verdict: 'weak' }),
      criterion({ id: 'AC-3', verdict: 'untestable' }),
    ]),
  );
  assert.equal(view.counts, '3/3 assessed · 1 proven');
  assert.equal(view.countsTooltip, 'proven 1 · weak 1 · missing 0 · untestable 1 · not assessed 0');
  // A weak criterion is still open work, so the panel starts expanded.
  assert.equal(view.hasOpenCriteria, true);
});

test('a run whose criteria are all settled starts collapsed', () => {
  // Untestable counts as settled: it is a recorded decision, not open work.
  const view = acceptancePanelPresentation(
    ledger([
      criterion({ id: 'AC-1', verdict: 'proven' }),
      criterion({ id: 'AC-2', verdict: 'untestable' }),
    ]),
  );
  assert.equal(view.counts, '2/2 assessed · 1 proven');
  assert.equal(view.hasOpenCriteria, false);
});

test('nothing assessed yet shows no proven count', () => {
  const view = acceptancePanelPresentation(ledger([]), [{ id: 'AC-1', text: 'Not judged yet' }]);
  assert.equal(view.counts, '0/1 assessed');
  assert.equal(view.hasOpenCriteria, true);
});

test('artifact-only replay output gets replay copy and the complete-step status', () => {
  const run = makeRun({
    completionPolicy: 'artifact-only',
    startRef: { requestedRef: 'main', resolvedSha: 'abc123' },
    steps: [{ name: 'complete', status: 'failed', durationMs: 1234 }],
  });
  const summary = runResultsSummary(run, 1);
  assert.equal(summary.shouldRender, true);
  assert.equal(summary.title, 'Replay evidence');
  assert.equal(summary.badge, 'comparison · artifact-only');
  assert.equal(summary.status, 'failed');
  assert.equal(summary.completeStep?.durationMs, 1234);
  assert.equal(summary.showEvalPackageHint, true);
  assert.match(summary.copy, /abc123/);
  assert.match(summary.copy, /eval Reference and Candidate packages/);
});

test('a review-workspace run shows its review process, not a results card', () => {
  const run = makeRun({
    completionPolicy: 'artifact-only',
    reviewWorkspaceTarget: { machine: 'macwork' },
  });
  assert.equal(runResultsSummary(run, 3).shouldRender, false);
});

test('a non-replay run without output or artifacts gets no results card', () => {
  assert.equal(runResultsSummary(makeRun({ status: 'done' }), 0).shouldRender, false);
  assert.equal(runResultsSummary(makeRun({ status: 'failed' }), 1).status, 'failed');
});

test('a finished QA run is a result to read, not a comparison or a passing verdict', () => {
  const run = makeRun({ flowType: 'qa', completionPolicy: 'artifact-only', status: 'blocked' });
  run.output = {
    workerFinished: true,
    capturedAt: '2026-10-16T20:11:33.507Z',
    artifactManifest: [],
    manifestDigest: 'digest',
    reportPath: 'artifacts/report.html',
  };
  run.metrics.outcome = 'partial';
  const summary = runResultsSummary(run, 0);
  assert.equal(summary.title, 'Run results');
  assert.equal(summary.badge, 'partial');
  assert.equal(summary.shouldRender, true);
  assert.doesNotMatch(summary.copy, /comparison|replay/i);
  assert.match(summary.copy, /findings and coverage gaps/);
  assert.match(summary.copy, /does not change the verdict/);
});

const outputReview = (resolvedAt?: string): Run['decisions'][number] => ({
  id: 'decision-output',
  type: 'engine_output_review',
  title: 'Review run output',
  description: 'QA output',
  actions: [],
  createdAt: '2026-10-16T20:11:33.507Z',
  ...(resolvedAt ? { resolvedAt } : {}),
  payload: {
    kind: 'output-review',
    reportPath: 'artifacts/report.html',
    manifestDigest: 'manifest-digest',
  },
});

test('only an open output review is the one run detail checks the report against', () => {
  const open = makeRun({ flowType: 'qa', decisions: [outputReview()] });
  assert.equal(pendingOutputReview(open)?.payload.manifestDigest, 'manifest-digest');
  const closed = makeRun({
    flowType: 'qa',
    decisions: [outputReview('2026-10-17T00:00:00.000Z')],
  });
  assert.equal(pendingOutputReview(closed), undefined);
  assert.equal(pendingOutputReview(null), undefined);
});
