import assert from 'node:assert/strict';
import { test } from 'node:test';

import type {
  FamilyObservabilityArtifact,
  FamilyObservabilityRunSummary,
  FamilyObservabilitySnapshot,
} from '@farmslot/protocol';

import {
  comparisonRuns,
  crossComparePrompt,
  familyCopilotCompareRequest,
  familyRunLabel,
} from './family-observability-compare-model.js';

function run(
  runId: string,
  lane: string,
  overrides: Record<string, unknown> = {},
): FamilyObservabilityRunSummary {
  return {
    runId,
    lane,
    status: 'done',
    flow: 'fix-bug',
    ticket: 'PROJ-1',
    title: 'Demo run',
    branch: 'fix/demo',
    createdAt: '2026-06-01T00:00:00Z',
    updatedAt: '2026-06-01T00:10:00Z',
    metrics: { runner: 'codex', model: 'gpt-5.5', nudgeCount: 0 },
    diffStat: { available: true, files: 2, additions: 10, deletions: 1 },
    recipeQuality: { semantic: 'good', evidence: 'good', notes: [] },
    selfReview: { verdict: 'approve', summary: null, issues: [] },
    artifacts: [],
    steps: [],
    decisions: [],
    links: [],
    ...overrides,
  } as unknown as FamilyObservabilityRunSummary;
}

function snapshot(
  runs: FamilyObservabilityRunSummary[],
  evidence: FamilyObservabilityArtifact[] = [],
): FamilyObservabilitySnapshot {
  return {
    familyId: 'family-demo',
    familyRootTicketOrPr: 'PROJ-1',
    latestRunId: runs[0]?.runId ?? '',
    runs,
    evidence,
  } as FamilyObservabilitySnapshot;
}

test('comparisonRuns only returns comparison lanes when there are at least two', () => {
  assert.deepEqual(
    comparisonRuns(snapshot([run('root', 'root'), run('compare-a', 'comparison')])),
    [],
  );

  const compareA = run('compare-a', 'comparison');
  const compareB = run('compare-b', 'comparison');
  assert.deepEqual(comparisonRuns(snapshot([run('root', 'root'), compareA, compareB])), [
    compareA,
    compareB,
  ]);
});

test('familyRunLabel prefers variant and falls back to runner-model', () => {
  assert.equal(familyRunLabel(run('a', 'comparison', { variant: 'safer patch' })), 'safer patch');
  assert.equal(familyRunLabel(run('b', 'comparison')), 'codex-gpt-5.5');
  assert.equal(familyRunLabel(run('c', 'comparison', { metrics: undefined })), 'runner-model');
});

test('crossComparePrompt summarizes comparison runs and evidence', () => {
  const prompt = crossComparePrompt(
    snapshot(
      [
        run('root', 'root'),
        run('compare-a', 'comparison', { variant: 'minimal fix', slotId: 'slot-a', prNumber: 42 }),
        run('compare-b', 'comparison', {
          diffStat: { available: false, files: 0, additions: 0, deletions: 0 },
          metrics: { runner: 'claude', model: 'sonnet', nudgeCount: 0 },
          recipeQuality: { semantic: 'unknown', evidence: 'good', notes: [] },
          selfReview: { verdict: 'needs-work', summary: null, issues: [] },
        }),
      ],
      [
        {
          runId: 'compare-a',
          sourceRunId: 'compare-a',
          path: 'artifacts/after.png',
          source: 'task-artifact',
        } as FamilyObservabilityArtifact,
      ],
    ),
  );

  assert.match(prompt, /Cross-compare comparison family family-demo for PROJ-1/);
  assert.match(prompt, /minimal fix \(compare-a\): status=done, runner=codex, model=gpt-5.5/);
  assert.match(prompt, /slot=slot-a, PR=42, diff=2 files \+10\/-1/);
  assert.match(prompt, /evidence=1 artifact · 1 img/);
  assert.match(prompt, /claude-sonnet \(compare-b\).*diff=diff unavailable/);
  assert.match(prompt, /recipe=unknown/);
  assert.match(prompt, /selfReview=needs-work/);
});

test('familyCopilotCompareRequest preserves compare prompt event detail', () => {
  const compareA = run('compare-a', 'comparison');
  const compareB = run('compare-b', 'comparison');
  const detail = familyCopilotCompareRequest(
    snapshot([run('root', 'root'), compareA, compareB]),
    '',
  );

  assert.equal(detail.intent, 'diagnostic-readonly');
  assert.equal(detail.runId, 'root');
  assert.equal(detail.sourceSurface, 'family-observability');
  assert.equal(detail.contextOverride.selectedFamilyId, 'family-demo');
  assert.equal(detail.contextOverride.selectedRunId, 'root');
  assert.deepEqual(detail.contextOverride.compareRunIds, ['compare-a', 'compare-b']);
  assert.deepEqual(detail.contextOverride.affordances, [
    'comparison-lane-analysis',
    'winner-selection',
    'evidence-provenance',
  ]);
  assert.match(detail.prompt, /Cross-compare comparison family family-demo for PROJ-1/);

  assert.equal(
    familyCopilotCompareRequest(snapshot([compareA, compareB]), 'compare-b').runId,
    'compare-b',
  );
});
