import assert from 'node:assert/strict';
import test from 'node:test';

import type { Run } from '../../src/contracts/runs.js';
import { RUN_LIST_STEP_ARTIFACT_LIMIT } from '../../src/runs/evidence-summary.js';
import { runListRow, trimRunForList } from '../../src/runs/list-trim.js';

import {
  diffArtifactCandidate,
  diffStatFromRun,
  evidenceSummaryFromRun,
  extractRunArtifactManifest,
  summarizeRunEvidence,
} from './default-branch-readers.fixtures.js';

/** A finished run with evidence of every kind a list surface shows, held in step outputs. */
function evidenceRun(): Run {
  return {
    id: 'older-client',
    familyId: 'family-older',
    lane: 'production',
    flowType: 'fix-bug',
    status: 'done',
    project: 'demo',
    ticketOrPr: 'TEAM-5',
    slotId: null,
    branch: 'fix/login',
    taskFile: null,
    steps: [
      {
        name: 'monitor',
        status: 'done',
        outputs: {
          transcript: 't'.repeat(4000),
          patch: 'artifacts/changes.patch',
          diffStat: { files: 3, additions: 20, deletions: 5 },
          artifacts: [
            { path: 'evidence/before-login.png', purpose: 'before screenshot', sizeBytes: 400 },
            { path: 'evidence/after-login.png', purpose: 'after screenshot', sizeBytes: 500 },
            { path: 'evidence/walkthrough.mp4', purpose: 'video', sizeBytes: 9000 },
            { path: 'reports/recipe-report.md', purpose: 'report', sizeBytes: 100 },
            { path: 'reviews/final-review.md', purpose: 'review', sizeBytes: 200 },
            { path: 'artifacts/check.txt', purpose: 'validation', sizeBytes: 50 },
          ],
        },
      },
    ],
    decisions: [
      {
        id: 'gate',
        type: 'engine_human_gate',
        title: 'Publish',
        description: 'Publish the fix.',
        createdAt: '2026-11-01T00:10:00.000Z',
        resolvedAt: '2026-11-01T00:12:00.000Z',
        actions: [],
        payload: {
          kind: 'ready',
          prNumber: null,
          repo: null,
          branch: 'fix/login',
          workerReport: 'Fixed the login crash.',
          diffStat: { files: 3, additions: 20, deletions: 5 },
          // A small gate manifest, under the list's per-value limit: both rows carry it.
          artifactManifest: [
            { path: 'artifacts/summary.md', purpose: 'summary' },
            { path: 'artifacts/trace.json', purpose: 'trace' },
          ],
        },
      },
    ],
    // A stored live recipe context, which both rows carry: its video counts on a list. (run.get
    // attaches one when it presents a run; run.list never did, on either branch.)
    liveRecipeContext: {
      source: 'recipe-run-artifacts',
      recipeRunId: 'recipe-1',
      artifactRoot: 'recipe-runs/recipe-1',
      artifactManifest: [{ path: 'recipe-runs/recipe-1/checkout.mp4', purpose: 'video' }],
      recipeJson: null,
      recipeQualityArtifact: null,
      qualityReport: null,
      workerLearnings: null,
      isStale: false,
      selectionReason: 'latest-run',
    },
    metrics: { nudgeCount: 0, model: 'opus', runner: 'claude' },
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:12:00.000Z',
  };
}

/** What a client holds after reading a row off the wire: it parses the JSON as a run. */
function received(row: object): Run {
  return JSON.parse(JSON.stringify(row));
}

// Clients update separately from the gateway. A build from the default branch computes its
// list values from the row itself, with the readers copied in the fixture file. On the row
// this branch serves, they give what they gave on the row the default branch serves.
test('default-branch readers show the same chips, Diff file and diff stat from the served row', () => {
  const run = evidenceRun();
  const before = received(trimRunForList(run));
  const served = received(runListRow(run));

  // Command Center run list: the video and compare chips.
  const chips = (row: Run) => {
    const { videoCount, visualPairCount } = summarizeRunEvidence(row);
    return { videoCount, visualPairCount };
  };
  assert.deepEqual(chips(before), { videoCount: 2, visualPairCount: 1 });
  assert.deepEqual(chips(served), chips(before));
  // A current build reads the gateway's summary: the same chips.
  const summary = runListRow(run).evidenceSummary;
  assert.deepEqual(
    { videoCount: summary?.videoCount, visualPairCount: summary?.visualPairCount },
    chips(before),
  );

  // Companion run cards: the file the Diff action opens.
  const diffPath = (row: Run) => diffArtifactCandidate(extractRunArtifactManifest(row))?.path;
  assert.equal(diffPath(before), 'artifacts/changes.patch');
  assert.equal(diffPath(served), diffPath(before));

  // Eval catalog preview: the diff stat.
  assert.deepEqual(diffStatFromRun(before), { files: 3, additions: 20, deletions: 5 });
  assert.deepEqual(diffStatFromRun(served), diffStatFromRun(before));
});

// (The before/after thumbnail on Companion's cards is not asserted: on the default branch
// `groupVisualArtifactPairs` pairs artifacts only through an evidence model, the cards pass
// none, and so the pair never rendered there.)

const CATALOG_COUNTS = [
  'artifactCount',
  'artifactBytes',
  'visualEvidenceCount',
  'validationEvidenceCount',
  'reviewEvidenceCount',
] as const;

/**
 * Each count an older build derives from the served row, against the same reader's count on
 * the default branch's row: never higher, and above zero when that one is. Every artifact it
 * finds is one it found before.
 */
function assertOlderCountsNeverGain(run: Run): void {
  const before = received(trimRunForList(run));
  const served = received(runListRow(run));
  const found = extractRunArtifactManifest(before);
  const shown = extractRunArtifactManifest(served);
  const known = new Set(found.map((entry) => entry.path));
  assert.deepEqual(
    shown.filter((entry) => !known.has(entry.path)),
    [],
    'an artifact the default-branch row did not hold',
  );
  assert.ok(shown.length <= found.length, 'Evidence N is higher');
  assert.equal(shown.length > 0, found.length > 0, 'Evidence N fell to zero');
  const catalogBefore = evidenceSummaryFromRun(before);
  const catalogServed = evidenceSummaryFromRun(served);
  for (const key of CATALOG_COUNTS)
    assert.ok(catalogServed[key] <= catalogBefore[key], `catalog ${key} is higher`);
  assert.equal(
    catalogServed.artifactCount > 0,
    catalogBefore.artifactCount > 0,
    'the catalog artifact count fell to zero',
  );
}

/** A run with only `outputs` in one step: the smallest input for a placement case. */
function stepRun(...outputs: Array<Record<string, unknown>>): Run {
  return {
    ...evidenceRun(),
    liveRecipeContext: undefined,
    decisions: [],
    steps: outputs.map((entry, index) => ({
      name: `step-${index}`,
      status: 'done',
      outputs: entry,
    })),
  };
}

// The served row keeps a step's videos, before/after visuals and diff files, not every
// artifact entry (stored runs average 92 of them). So the counts an older build derives are
// lower than before until it updates: never higher than that build showed before, never zero
// for a run with evidence. A current build reads the gateway's summary.
test('default-branch readers count fewer artifacts from the served row, never more and not none', () => {
  const run = evidenceRun();
  const before = received(trimRunForList(run));
  const served = received(runListRow(run));
  assertOlderCountsNeverGain(run);

  // Companion "Evidence N": the pair, the video, the patch, the gate's two files and the
  // recipe video, of the nine the default-branch row gave.
  assert.equal(extractRunArtifactManifest(before).length, 9);
  assert.equal(extractRunArtifactManifest(served).length, 6);

  // Eval catalog preview counts: the three kept entries of the step's six.
  assert.deepEqual(evidenceSummaryFromRun(before), {
    artifactCount: 6,
    artifactBytes: 10250,
    visualEvidenceCount: 3,
    validationEvidenceCount: 2,
    reviewEvidenceCount: 1,
  });
  assert.deepEqual(evidenceSummaryFromRun(served), {
    artifactCount: 3,
    artifactBytes: 9900,
    visualEvidenceCount: 3,
    validationEvidenceCount: 0,
    reviewEvidenceCount: 0,
  });

  // A step with only reports keeps its first one, so those counts are never zero for it.
  const reports = stepRun({
    artifacts: [
      { path: 'reports/recipe-report.md', purpose: 'report', sizeBytes: 100 },
      { path: 'reports/coverage.md', purpose: 'coverage', sizeBytes: 300 },
    ],
  });
  assertOlderCountsNeverGain(reports);
  assert.deepEqual(evidenceSummaryFromRun(received(runListRow(reports))), {
    artifactCount: 1,
    artifactBytes: 100,
    visualEvidenceCount: 0,
    validationEvidenceCount: 1,
    reviewEvidenceCount: 0,
  });

  // A current build shows the default branch's catalog numbers from the gateway's summary.
  assert.deepEqual(runListRow(run).evidenceSummary?.catalogCounts, evidenceSummaryFromRun(before));
  assert.deepEqual(runListRow(run).evidenceSummary?.diffStat, diffStatFromRun(before));
  assert.equal(runListRow(run).evidenceSummary?.diffArtifactPath, 'artifacts/changes.patch');
});

// The row holds a subset of what the step held, in the same places: a file recorded under
// another output key stays under that key and never becomes an `artifacts` entry, which is the
// only place an older build's catalog counts.
test('a kept artifact stays where the step held it, so no older reader counts more', () => {
  // A video in `artifacts` and a patch under its own key: the catalog read one artifact.
  const patched = stepRun({
    artifacts: [{ path: 'evidence/proof.mp4', purpose: 'video', sizeBytes: 10 }],
    patch: 'artifacts/changes.patch',
    transcript: 't'.repeat(2000),
  });
  const patchedServed = received(runListRow(patched));
  assert.deepEqual(patchedServed.steps[0]?.outputs, {
    artifacts: [{ path: 'evidence/proof.mp4', purpose: 'video', sizeBytes: 10 }],
    patch: 'artifacts/changes.patch',
  });
  assert.deepEqual(
    evidenceSummaryFromRun(patchedServed),
    evidenceSummaryFromRun(received(trimRunForList(patched))),
  );
  assert.equal(evidenceSummaryFromRun(patchedServed).artifactCount, 1);
  assertOlderCountsNeverGain(patched);

  // A screenshot under its own key and no `artifacts`: the catalog read none, and still does.
  const shot = stepRun({ screenshot: 'evidence/before-login.png', notes: 'n'.repeat(2000) });
  const shotServed = received(runListRow(shot));
  assert.deepEqual(shotServed.steps[0]?.outputs, { screenshot: 'evidence/before-login.png' });
  assert.deepEqual(
    evidenceSummaryFromRun(shotServed),
    evidenceSummaryFromRun(received(trimRunForList(shot))),
  );
  assert.equal(evidenceSummaryFromRun(shotServed).visualEvidenceCount, 0);
  assertOlderCountsNeverGain(shot);

  // A path nested inside another output stays at the same place, without its neighbours.
  const nested = stepRun({
    reviews: [
      { verdict: 'pass', reviewSnapshot: { diffPath: 'artifacts/review.diff', headSha: 'abc' } },
    ],
  });
  assert.deepEqual(received(runListRow(nested)).steps[0]?.outputs, {
    reviews: [{ reviewSnapshot: { diffPath: 'artifacts/review.diff' } }],
  });
  assertOlderCountsNeverGain(nested);
});

// One unusual run cannot bring tens of KB back: a row keeps a bounded number of videos and
// visuals across its steps, and a step that lost any is marked trimmed. Diff files do not
// count against the limit, so the file an older build's Diff action opens is never cut.
test('the artifact limit cuts videos and visuals across steps and never a diff file', () => {
  const videos = (step: string, count: number) =>
    Array.from({ length: count }, (_, index) => ({
      path: `evidence/${step}-${index}.mp4`,
      purpose: 'video',
      sizeBytes: 1000,
    }));
  const run = stepRun(
    { artifacts: videos('monitor', 70), patch: 'evidence/notes.patch' },
    { artifacts: videos('recipe', 70) },
    { artifacts: videos('review', 5) },
    // The best-ranked diff file, in the last step, after the limit is spent.
    { patch: 'artifacts/diff.txt' },
  );
  const row = runListRow(run);
  const kept = row.steps.map((step) =>
    Array.isArray(step.outputs?.artifacts) ? step.outputs.artifacts.length : 0,
  );
  // The limit is spent in step order; a step cut to nothing keeps its first artifact.
  assert.deepEqual(kept, [70, RUN_LIST_STEP_ARTIFACT_LIMIT - 70, 1, 0]);
  assert.deepEqual(
    row.steps.map((step) => step.outputsTrimmed),
    [undefined, true, true, undefined],
  );
  assert.equal(row.steps[0]?.outputs?.patch, 'evidence/notes.patch');
  assert.equal(row.steps[3]?.outputs?.patch, 'artifacts/diff.txt');

  // The default-branch Diff reader picks the same file from the served row.
  const diffPath = (listed: Run) => diffArtifactCandidate(extractRunArtifactManifest(listed))?.path;
  assert.equal(diffPath(received(trimRunForList(run))), 'artifacts/diff.txt');
  assert.equal(diffPath(received(row)), 'artifacts/diff.txt');

  // The gateway's summary still counts every video; only an older build's own count is cut.
  assert.equal(row.evidenceSummary?.videoCount, 145);
  assert.equal(summarizeRunEvidence(received(row)).videoCount, RUN_LIST_STEP_ARTIFACT_LIMIT + 1);
  assertOlderCountsNeverGain(run);
});
