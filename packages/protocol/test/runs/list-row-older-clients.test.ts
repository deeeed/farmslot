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

// The served row keeps a step's videos, before/after visuals and diff files, not every
// artifact entry (stored runs average 92 of them). So the counts an older build derives are
// lower than before until it updates: never zero for a run with evidence, never higher than
// the truth. A current build reads the gateway's summary.
test('default-branch readers count fewer artifacts from the served row, never more and not none', () => {
  const run = evidenceRun();
  const before = received(trimRunForList(run));
  const served = received(runListRow(run));

  // Companion "Evidence N".
  const truth = extractRunArtifactManifest(before).length;
  const shown = extractRunArtifactManifest(served).length;
  assert.equal(truth, 9);
  assert.equal(shown, 6);
  assert.ok(shown > 0 && shown <= truth);

  // Eval catalog preview counts.
  const catalogTruth = evidenceSummaryFromRun(before);
  const catalogShown = evidenceSummaryFromRun(served);
  assert.deepEqual(catalogTruth, {
    artifactCount: 6,
    artifactBytes: 10250,
    visualEvidenceCount: 3,
    validationEvidenceCount: 2,
    reviewEvidenceCount: 1,
  });
  assert.deepEqual(catalogShown, {
    artifactCount: 4,
    artifactBytes: 9900,
    visualEvidenceCount: 3,
    validationEvidenceCount: 0,
    reviewEvidenceCount: 0,
  });
  assert.ok(catalogShown.artifactCount > 0 && catalogShown.artifactBytes > 0);
  for (const key of [
    'artifactCount',
    'artifactBytes',
    'visualEvidenceCount',
    'validationEvidenceCount',
    'reviewEvidenceCount',
  ] as const)
    assert.ok(catalogShown[key] <= catalogTruth[key], key);

  // A step with only reports keeps its first one, so those counts are never zero for it.
  const reports: Run = {
    ...run,
    liveRecipeContext: undefined,
    decisions: [],
    steps: [
      {
        name: 'monitor',
        status: 'done',
        outputs: {
          artifacts: [
            { path: 'reports/recipe-report.md', purpose: 'report', sizeBytes: 100 },
            { path: 'reports/coverage.md', purpose: 'coverage', sizeBytes: 300 },
          ],
        },
      },
    ],
  };
  const reportsServed = received(runListRow(reports));
  assert.equal(extractRunArtifactManifest(reportsServed).length, 1);
  assert.deepEqual(evidenceSummaryFromRun(reportsServed), {
    artifactCount: 1,
    artifactBytes: 100,
    visualEvidenceCount: 0,
    validationEvidenceCount: 1,
    reviewEvidenceCount: 0,
  });

  // A current build shows the default branch's catalog numbers from the gateway's summary.
  assert.deepEqual(runListRow(run).evidenceSummary?.catalogCounts, catalogTruth);
  assert.deepEqual(runListRow(run).evidenceSummary?.diffStat, diffStatFromRun(before));
  assert.equal(runListRow(run).evidenceSummary?.diffArtifactPath, 'artifacts/changes.patch');
});

// One unusual run cannot bring tens of KB back: a row keeps a bounded number of step artifacts
// across its steps, and a step that lost any is marked trimmed.
test('a row keeps at most the artifact limit across its steps', () => {
  const videos = (step: string, count: number) =>
    Array.from({ length: count }, (_, index) => ({
      path: `evidence/${step}-${index}.mp4`,
      purpose: 'video',
      sizeBytes: 1000,
    }));
  const run: Run = {
    ...evidenceRun(),
    liveRecipeContext: undefined,
    decisions: [],
    steps: [
      { name: 'monitor', status: 'done', outputs: { artifacts: videos('monitor', 70) } },
      { name: 'recipe', status: 'done', outputs: { artifacts: videos('recipe', 70) } },
      { name: 'review', status: 'done', outputs: { artifacts: videos('review', 5) } },
    ],
  };
  const row = runListRow(run);
  const kept = row.steps.map((step) =>
    Array.isArray(step.outputs?.artifacts) ? step.outputs.artifacts.length : 0,
  );
  assert.deepEqual(kept, [70, RUN_LIST_STEP_ARTIFACT_LIMIT - 70, 0]);
  // The first step lost nothing; the two the cap cut say so.
  assert.deepEqual(
    row.steps.map((step) => step.outputsTrimmed),
    [undefined, true, true],
  );
  // The gateway's summary still counts every video; only an older build's own count is capped.
  assert.equal(row.evidenceSummary?.videoCount, 145);
  assert.equal(summarizeRunEvidence(received(row)).videoCount, RUN_LIST_STEP_ARTIFACT_LIMIT);
});
