import assert from 'node:assert/strict';
import test from 'node:test';

import type { Run } from '../../src/contracts/runs.js';
import {
  RUN_LIST_STEP_OUTPUT_VALUE_LIMIT,
  runListRow,
  trimRunForList,
} from '../../src/runs/list-trim.js';

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
            {
              path: 'evidence/before-login.png',
              purpose: 'before screenshot',
              sizeBytes: 400,
              label: 'Recorded by the recipe run',
            },
            {
              path: 'evidence/after-login.png',
              purpose: 'after screenshot',
              sizeBytes: 500,
              label: 'Recorded by the recipe run',
            },
            {
              path: 'evidence/walkthrough.mp4',
              purpose: 'video',
              sizeBytes: 9000,
              label: 'Recorded by the recipe run',
            },
            {
              path: 'reports/recipe-report.md',
              purpose: 'report',
              sizeBytes: 100,
              label: 'Recorded by the recipe run',
            },
            {
              path: 'reviews/final-review.md',
              purpose: 'review',
              sizeBytes: 200,
              label: 'Recorded by the recipe run',
            },
            {
              path: 'artifacts/check.txt',
              purpose: 'validation',
              sizeBytes: 50,
              label: 'Recorded by the recipe run',
            },
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

/** Report entries that push an `artifacts` array over the size line. */
function reportEntries(count: number): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, index) => ({
    path: `reports/section-${index}.md`,
    purpose: 'report',
    sizeBytes: 100,
    label: `Section ${index} of the recipe report`,
  }));
}

const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

// A step-output value of at most 512 B is served as stored. A larger one keeps only its videos,
// before/after visuals and diff files, not every entry (stored runs average 92 of them). So the
// counts an older build derives are lower or equal: never higher than that build showed
// before, and not zero for these steps. A current build reads the gateway's summary.
test('default-branch readers count fewer artifacts from the served row, never more and not none', () => {
  const run = evidenceRun();
  const before = received(trimRunForList(run));
  const served = received(runListRow(run));
  assertOlderCountsNeverGain(run);

  // The step's six artifacts are over the size line: the pair and the video stay, each as its
  // path, purpose and size; the report, the review file and the validation file go.
  assert.ok(jsonBytes(run.steps[0]?.outputs?.artifacts) > RUN_LIST_STEP_OUTPUT_VALUE_LIMIT);
  assert.deepEqual(served.steps[0]?.outputs?.artifacts, [
    { path: 'evidence/before-login.png', purpose: 'before screenshot', sizeBytes: 400 },
    { path: 'evidence/after-login.png', purpose: 'after screenshot', sizeBytes: 500 },
    { path: 'evidence/walkthrough.mp4', purpose: 'video', sizeBytes: 9000 },
  ]);
  assert.equal(extractRunArtifactManifest(before).length, 9);
  assert.equal(extractRunArtifactManifest(served).length, 6);
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

  // A long list of reports only: its first entry stays, so the counts are not zero.
  const reports = stepRun({ artifacts: reportEntries(12) });
  assertOlderCountsNeverGain(reports);
  assert.deepEqual(received(runListRow(reports)).steps[0]?.outputs?.artifacts, [
    { path: 'reports/section-0.md', purpose: 'report', sizeBytes: 100 },
  ]);
  // A short list of reports is under the line and served whole: the same counts as before.
  const fewReports = stepRun({ artifacts: reportEntries(2) });
  assert.deepEqual(
    evidenceSummaryFromRun(received(runListRow(fewReports))),
    evidenceSummaryFromRun(received(trimRunForList(fewReports))),
  );

  // A current build shows the default branch's catalog numbers from the gateway's summary.
  assert.deepEqual(runListRow(run).evidenceSummary?.catalogCounts, evidenceSummaryFromRun(before));
  assert.deepEqual(runListRow(run).evidenceSummary?.diffStat, diffStatFromRun(before));
  assert.equal(runListRow(run).evidenceSummary?.diffArtifactPath, 'artifacts/changes.patch');
});

// The row holds a subset of what the step held, in the same places: nothing is moved between
// keys, so a file recorded under another key never becomes an `artifacts` entry, which is the
// only place an older build's catalog counts.
test('small step outputs are served as stored and a large one keeps its artifacts in place', () => {
  // A video in `artifacts` and a patch under its own key: the catalog read one artifact.
  const patched = stepRun({
    artifacts: [{ path: 'evidence/proof.mp4', purpose: 'video', sizeBytes: 10 }],
    patch: 'artifacts/changes.patch',
    retryCount: 2,
    transcript: 't'.repeat(2000),
  });
  const patchedServed = received(runListRow(patched));
  assert.deepEqual(patchedServed.steps[0]?.outputs, {
    artifacts: [{ path: 'evidence/proof.mp4', purpose: 'video', sizeBytes: 10 }],
    patch: 'artifacts/changes.patch',
    retryCount: 2,
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

  // A short `artifacts` list is served as stored, so an entry recognised only by its type
  // stays recognised: "Evidence 1" on both rows.
  const typed = stepRun({ artifacts: [{ path: 'data/results.csv', type: 'report' }] });
  assert.equal(extractRunArtifactManifest(received(trimRunForList(typed))).length, 1);
  assert.equal(extractRunArtifactManifest(received(runListRow(typed))).length, 1);
  assertOlderCountsNeverGain(typed);

  // A path nested inside a large value stays at the same place, without its neighbours.
  const nested = stepRun({
    reviews: [
      {
        verdict: 'pass',
        summary: 's'.repeat(600),
        reviewSnapshot: { diffPath: 'artifacts/review.diff', headSha: 'abc' },
      },
    ],
  });
  assert.deepEqual(received(runListRow(nested)).steps[0]?.outputs, {
    reviews: [{ reviewSnapshot: { diffPath: 'artifacts/review.diff' } }],
  });
  assertOlderCountsNeverGain(nested);
});

// The fleet map's expanded pipeline on a build from the default branch reads a review step's
// id, retry counts, open findings and cost, and a finalize step's booleans, from the row. Each
// is a top-level value of at most 512 B, so the served row holds it as stored.
test('a review step and a finalize step keep their small top-level values as stored', () => {
  const review = {
    verdict: 'pass',
    reviewId: 'rev-1',
    retryCount: 2,
    maxRetries: 3,
    unresolvedCount: 0,
    costEstimate: 0.42,
  };
  const finalize = {
    commentPosted: true,
    metricsSavedToTask: true,
    prTitleUpdated: true,
    prMarkedReady: false,
    prCommentPosted: true,
  };
  const run = stepRun(
    { ...review, transcript: 't'.repeat(2000) },
    { ...finalize, log: 'l'.repeat(2000) },
  );
  const served = received(runListRow(run));
  assert.deepEqual(served.steps[0]?.outputs, review);
  assert.deepEqual(served.steps[1]?.outputs, finalize);
  // The long transcript and log are left out, and the steps say so.
  assert.deepEqual(
    served.steps.map((step) => step.outputsTrimmed),
    [true, true],
  );
});

// A row keeps every video, before/after visual and diff file of a run, however many: there is
// no per-run limit, so a later step's pair is never cut by an earlier step's videos.
test('a later step keeps its before/after pair after a hundred videos in an earlier step', () => {
  const videos = Array.from({ length: 100 }, (_, index) => ({
    path: `evidence/monitor-${index}.mp4`,
    purpose: 'video',
    sizeBytes: 1000,
  }));
  const run = stepRun(
    { artifacts: videos },
    {
      artifacts: [
        ...reportEntries(12),
        { path: 'evidence/before-login.png', purpose: 'before screenshot' },
        { path: 'evidence/after-login.png', purpose: 'after screenshot' },
      ],
    },
  );
  const chips = (row: Run) => {
    const { videoCount, visualPairCount } = summarizeRunEvidence(row);
    return { videoCount, visualPairCount };
  };
  assert.deepEqual(chips(received(trimRunForList(run))), { videoCount: 100, visualPairCount: 1 });
  assert.deepEqual(chips(received(runListRow(run))), { videoCount: 100, visualPairCount: 1 });
  assertOlderCountsNeverGain(run);
});
