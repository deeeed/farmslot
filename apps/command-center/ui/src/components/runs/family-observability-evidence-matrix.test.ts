import assert from 'node:assert/strict';
import { test } from 'node:test';

import type {
  FamilyObservabilityArtifact,
  FamilyObservabilityRunSummary,
  FamilyObservabilitySnapshot,
} from '@farmslot/protocol';

import {
  buildEvidenceComparisonMatrix,
  evidenceRowArtifacts,
} from './family-observability-evidence-matrix.js';

function run(runId: string, variant: string): FamilyObservabilityRunSummary {
  return {
    runId,
    lane: 'comparison',
    status: 'done',
    variant,
    metrics: { runner: 'codex', model: 'gpt-5.5', nudgeCount: 0 },
  } as unknown as FamilyObservabilityRunSummary;
}

function art(
  runId: string,
  path: string,
  purpose = 'recipe-evidence',
): FamilyObservabilityArtifact {
  return {
    runId,
    sourceRunId: runId,
    path,
    purpose,
    source: 'task-artifact',
  } as unknown as FamilyObservabilityArtifact;
}

function snapshot(
  runs: FamilyObservabilityRunSummary[],
  evidence: FamilyObservabilityArtifact[],
): FamilyObservabilitySnapshot {
  return { familyId: 'fam', runs, evidence } as unknown as FamilyObservabilitySnapshot;
}

test('matrix lines up the same stem across runs and labels columns by variant', () => {
  const matrix = buildEvidenceComparisonMatrix(
    snapshot(
      [run('a', 'opus'), run('b', 'codex')],
      [art('a', 'artifacts/after-swap-confirm.png'), art('b', 'artifacts/after-swap-confirm.png')],
    ),
  );
  assert.deepEqual(
    matrix.runs.map((r) => r.label),
    ['opus', 'codex'],
  );
  assert.equal(matrix.rows.length, 1);
  assert.equal(matrix.rows[0].label, 'swap confirm');
  assert.equal(matrix.rows[0].coverage, 2);
  assert.deepEqual(
    matrix.rows[0].cells.map((c) => c.artifact?.runId ?? null),
    ['a', 'b'],
  );
  assert.deepEqual(
    matrix.rows[0].cells.map((c) => c.kind),
    ['image', 'image'],
  );
});

test('a screen captured by only one run moves to the uncompared strip (not dropped)', () => {
  const matrix = buildEvidenceComparisonMatrix(
    snapshot(
      [run('a', 'opus'), run('b', 'codex')],
      [
        art('a', 'artifacts/after-only-a.png'),
        art('a', 'artifacts/after-shared.png'),
        art('b', 'artifacts/after-shared.png'),
      ],
    ),
  );
  assert.deepEqual(
    matrix.rows.map((r) => r.label),
    ['shared'],
  );
  assert.deepEqual(
    matrix.uncompared.map((u) => [u.runId, u.artifacts.map((a) => a.artifact.path)]),
    [['a', ['artifacts/after-only-a.png']]],
  );
});

test('acceptance-criteria token aligns differently-named screenshots across runs', () => {
  const matrix = buildEvidenceComparisonMatrix(
    snapshot(
      [run('a', 'opus'), run('b', 'codex')],
      [
        // Same AC (ac2), different descriptive names — should still line up.
        art('a', 'artifacts/after-ac2-eth-banner-visible.png'),
        art('b', 'artifacts/after-ac2-banner-visible.png'),
      ],
    ),
  );
  assert.equal(matrix.rows.length, 1);
  assert.equal(matrix.rows[0].coverage, 2);
  // Label uses the longest (most descriptive) stem in the group.
  assert.equal(matrix.rows[0].label, 'ac2 eth banner visible');
  assert.equal(matrix.uncompared.length, 0);
});

test('after capture is preferred over before for the cell', () => {
  const matrix = buildEvidenceComparisonMatrix(
    snapshot(
      [run('a', 'opus'), run('b', 'codex')],
      [
        art('a', 'artifacts/before-swap.png'),
        art('a', 'artifacts/after-swap.png'),
        art('b', 'artifacts/after-swap.png'),
      ],
    ),
  );
  const cellA = matrix.rows[0].cells.find((c) => c.runId === 'a');
  assert.match(cellA?.artifact?.path ?? '', /after-swap\.png$/);
});

test('a setup-named screenshot with an AC token still aligns (codex naming case)', () => {
  const matrix = buildEvidenceComparisonMatrix(
    snapshot(
      [run('a', 'opus'), run('b', 'codex')],
      [
        art('a', 'artifacts/after-ac2-banner.png'), // after-marked
        // No after/evidence prefix -> classified 'setup', but carries ac2.
        art('b', 'artifacts/ac2-screenshot-banner.png'),
      ],
    ),
  );
  assert.equal(matrix.rows.length, 1);
  assert.equal(matrix.rows[0].coverage, 2);
  assert.equal(matrix.uncompared.length, 0);
});

test('non-visual artifacts (reports, .md) are excluded', () => {
  const matrix = buildEvidenceComparisonMatrix(
    snapshot(
      [run('a', 'opus'), run('b', 'codex')],
      [
        art('a', 'artifacts/report.md'),
        art('b', 'artifacts/review-feedback.md'),
        art('a', 'artifacts/after-x.png'),
        art('b', 'artifacts/after-x.png'),
      ],
    ),
  );
  assert.deepEqual(
    matrix.rows.map((r) => r.label),
    ['x'],
  );
  assert.equal(matrix.uncompared.length, 0);
});

test('video captures are flagged as video cells', () => {
  const matrix = buildEvidenceComparisonMatrix(
    snapshot(
      [run('a', 'opus'), run('b', 'codex')],
      [art('a', 'artifacts/after-flow.mp4'), art('b', 'artifacts/after-flow.mp4')],
    ),
  );
  assert.deepEqual(
    matrix.rows[0].cells.map((c) => c.kind),
    ['video', 'video'],
  );
});

test('fewer than two comparison runs yields an empty matrix', () => {
  assert.deepEqual(buildEvidenceComparisonMatrix(snapshot([run('a', 'opus')], [])), {
    runs: [],
    rows: [],
    uncompared: [],
  });
  assert.deepEqual(buildEvidenceComparisonMatrix(null), { runs: [], rows: [], uncompared: [] });
});

test('evidenceRowArtifacts returns covered cells in column order, skipping gaps', () => {
  const matrix = buildEvidenceComparisonMatrix(
    snapshot(
      [run('a', 'opus'), run('b', 'codex'), run('c', 'grok')],
      [art('a', 'artifacts/after-x.png'), art('c', 'artifacts/after-x.png')],
    ),
  );
  const artifacts = evidenceRowArtifacts(matrix.rows[0]);
  assert.deepEqual(
    artifacts.map((a) => a.runId),
    ['a', 'c'],
  );
});
