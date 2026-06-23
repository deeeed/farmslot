import assert from 'node:assert/strict';
import { test } from 'node:test';

import type {
  FamilyObservabilityArtifact,
  FamilyObservabilityRunSummary,
  FamilyObservabilitySnapshot,
} from '@farmslot/protocol';

import {
  buildComparisonLeaderboard,
  COMPARE_SORT_SCORE,
  comparisonRuns,
  crossComparePrompt,
  familyCopilotCompareRequest,
  familyRunLabel,
  formatCompactNumber,
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

// ─── leaderboard / matrix model ───

interface CompareMetrics {
  durationMs?: number;
  sessionTotalTokens?: number;
  sessionOutputTokens?: number;
  nudgeCount?: number;
  sessionTurns?: number;
}

function lane(
  runId: string,
  variant: string,
  metrics: CompareMetrics,
  overrides: Record<string, unknown> = {},
): FamilyObservabilityRunSummary {
  return run(runId, 'comparison', {
    variant,
    metrics: { runner: 'codex', model: 'gpt-5.5', nudgeCount: 0, ...metrics },
    ciChecks: [{ name: 'build', status: 'completed', conclusion: 'success' }],
    ...overrides,
  });
}

function cell(
  row: { cells: { key: string; value: number | null; winner: boolean }[] },
  key: string,
) {
  const found = row.cells.find((c) => c.key === key);
  assert.ok(found, `cell ${key} should exist`);
  return found;
}

test('buildComparisonLeaderboard crowns the most efficient run and ranks by score', () => {
  const fast = lane('fast', 'opus', {
    durationMs: 600_000,
    sessionTotalTokens: 50_000,
    sessionOutputTokens: 30_000,
    nudgeCount: 0,
    sessionTurns: 10,
  });
  const slow = lane('slow', 'grok', {
    durationMs: 1_200_000,
    sessionTotalTokens: 120_000,
    sessionOutputTokens: 90_000,
    nudgeCount: 3,
    sessionTurns: 24,
  });
  const { rows } = buildComparisonLeaderboard([slow, fast]);

  assert.deepEqual(
    rows.map((r) => r.runId),
    ['fast', 'slow'],
  );
  assert.equal(rows[0].rank, 1);
  assert.ok((rows[0].score ?? 0) > (rows[1].score ?? 0));
  // Fast run wins every scored column; slow run wins none.
  for (const key of ['duration', 'totalTokens', 'outTokens', 'nudges', 'turns']) {
    assert.equal(cell(rows[0], key).winner, true, `fast should win ${key}`);
    assert.equal(cell(rows[1], key).winner, false, `slow should not win ${key}`);
  }
});

test('a column with no spread crowns no winner', () => {
  const a = lane('a', 'opus', { durationMs: 500_000, nudgeCount: 2 });
  const b = lane('b', 'codex', { durationMs: 900_000, nudgeCount: 2 });
  const { rows } = buildComparisonLeaderboard([a, b]);
  // nudges tie at 2 → neither wins; duration differs → a wins.
  assert.equal(cell(rows.find((r) => r.runId === 'a')!, 'nudges').winner, false);
  assert.equal(cell(rows.find((r) => r.runId === 'b')!, 'nudges').winner, false);
  assert.equal(cell(rows.find((r) => r.runId === 'a')!, 'duration').winner, true);
});

test('a missing metric counts as worst and never wins its column', () => {
  // Three runs so outTokens is a real contest (>=2 defined + spread). Duration
  // and nudges are equal across all, so outTokens is the only scored column.
  const best = lane('best', 'opus', { durationMs: 500_000, sessionOutputTokens: 30_000 });
  const worse = lane('worse', 'codex', { durationMs: 500_000, sessionOutputTokens: 60_000 });
  const missing = lane('missing', 'grok', { durationMs: 500_000, sessionOutputTokens: undefined });
  const { rows } = buildComparisonLeaderboard([best, worse, missing]);
  const missingRow = rows.find((r) => r.runId === 'missing')!;
  const bestRow = rows.find((r) => r.runId === 'best')!;
  assert.equal(cell(missingRow, 'outTokens').value, null);
  assert.equal(cell(missingRow, 'outTokens').winner, false);
  assert.equal(cell(bestRow, 'outTokens').winner, true);
  // Present-tokens leader outscores the run that hid its tokens (missing = worst).
  assert.ok((bestRow.score ?? 0) > (missingRow.score ?? 0));
});

test("the 'none'-direction diff column never crowns a winner", () => {
  const small = lane(
    'small',
    'opus',
    {},
    { diffStat: { available: true, files: 1, additions: 5, deletions: 1 } },
  );
  const large = lane(
    'large',
    'codex',
    {},
    { diffStat: { available: true, files: 9, additions: 400, deletions: 90 } },
  );
  const { rows } = buildComparisonLeaderboard([small, large]);
  for (const row of rows) {
    assert.equal(cell(row, 'diff').winner, false, `${row.runId} diff must not be a winner`);
  }
});

test('CI winner reflects green vs failing checks', () => {
  const green = lane('green', 'opus', { durationMs: 500_000 });
  const red = lane(
    'red',
    'codex',
    { durationMs: 500_000 },
    { ciChecks: [{ name: 'build', status: 'completed', conclusion: 'failure' }] },
  );
  const { rows } = buildComparisonLeaderboard([green, red]);
  assert.equal(cell(rows.find((r) => r.runId === 'green')!, 'ci').winner, true);
  assert.equal(cell(rows.find((r) => r.runId === 'red')!, 'ci').winner, false);
});

test('sortKey orders by a chosen column, best-first', () => {
  const a = lane('a', 'opus', { durationMs: 900_000 });
  const b = lane('b', 'codex', { durationMs: 300_000 });
  const c = lane('c', 'grok', { durationMs: 600_000 });
  const { rows, sortKey } = buildComparisonLeaderboard([a, b, c], 'duration');
  assert.equal(sortKey, 'duration');
  assert.deepEqual(
    rows.map((r) => r.runId),
    ['b', 'c', 'a'], // ascending duration (lower-better)
  );
});

test('default sortKey is the composite score', () => {
  const { sortKey } = buildComparisonLeaderboard([
    lane('a', 'opus', { durationMs: 1 }),
    lane('b', 'codex', { durationMs: 2 }),
  ]);
  assert.equal(sortKey, COMPARE_SORT_SCORE);
});

test('formatCompactNumber renders dense token counts', () => {
  assert.equal(formatCompactNumber(undefined), '—');
  assert.equal(formatCompactNumber(900), '900');
  assert.equal(formatCompactNumber(84_213), '84.2k');
  assert.equal(formatCompactNumber(120_000), '120k');
  assert.equal(formatCompactNumber(2_500_000), '2.5M');
});
