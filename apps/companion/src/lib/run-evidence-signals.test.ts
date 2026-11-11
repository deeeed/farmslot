import assert from 'node:assert/strict';
import test from 'node:test';

import { type Run, type RunEvidenceSummary, runListRow, trimRunForList } from '@farmslot/protocol';

import { normalizeFamilyEvidenceFilterParam } from './family-evidence';
import {
  runEvidenceSignalRouteTarget,
  runEvidenceSignals,
  summarizeRunEvidenceSignals,
} from './run-evidence-signals';

function summary(
  counts: Pick<RunEvidenceSummary, 'artifactCount' | 'videoCount' | 'visualPairCount'>,
) {
  const full: RunEvidenceSummary = {
    ...counts,
    artifactBytes: 0,
    visualEvidenceCount: 0,
    validationEvidenceCount: 0,
    reviewEvidenceCount: 0,
  };
  return full;
}

test('runEvidenceSignals exposes video and compare signal labels', () => {
  assert.deepEqual(
    runEvidenceSignals(summary({ artifactCount: 4, videoCount: 1, visualPairCount: 2 })),
    [
      {
        kind: 'video',
        label: 'Video 1',
        count: 1,
        title: '1 video artifact available',
      },
      {
        kind: 'compare',
        label: 'Compare 2',
        count: 2,
        title: '2 before/after pairs available',
      },
    ],
  );
  assert.deepEqual(
    runEvidenceSignals(summary({ artifactCount: 0, videoCount: 0, visualPairCount: 0 })),
    [],
  );
});

test('runEvidenceSignalRouteTarget maps signal chips to family workspace route params', () => {
  assert.deepEqual(runEvidenceSignalRouteTarget({ kind: 'video' }), {
    section: 'evidence',
    evidence: 'videos',
  });
  assert.deepEqual(runEvidenceSignalRouteTarget({ kind: 'compare' }), { section: 'compare' });
});

test('summarizeRunEvidenceSignals uses shared protocol evidence parsing', () => {
  const run: Pick<Run, 'decisions' | 'steps' | 'liveRecipeContext'> = {
    decisions: [],
    liveRecipeContext: {
      source: 'recipe-run-artifacts',
      recipeRunId: null,
      artifactRoot: null,
      artifactManifest: [
        { path: 'evidence/before-login.png', purpose: 'before screenshot' },
        { path: 'evidence/after-login.png', purpose: 'after screenshot' },
      ],
      recipeJson: null,
      recipeQualityArtifact: null,
      qualityReport: null,
      workerLearnings: null,
      isStale: false,
      selectionReason: 'latest-run',
    },
    steps: [
      {
        name: 'recipe',
        status: 'done',
        outputs: { video: 'artifacts/demo-after.mp4' },
      },
    ],
  };
  const signals = summarizeRunEvidenceSignals(run);

  assert.equal(signals.find((signal) => signal.kind === 'compare')?.label, 'Compare 1');
  assert.equal(signals.find((signal) => signal.kind === 'video')?.label, 'Video 1');
});

test('a slim row, its full run and an old cached row show the same evidence signals', () => {
  const full: Run = {
    id: 'run-evidence',
    familyId: 'family-evidence',
    lane: 'production',
    flowType: 'fix-bug',
    status: 'done',
    project: 'example-mobile',
    ticketOrPr: 'PR-7',
    slotId: null,
    branch: null,
    taskFile: null,
    steps: [
      {
        name: 'recipe',
        status: 'done',
        outputs: {
          video: 'artifacts/demo-after.mp4',
          screenshots: ['evidence/before-login.png', 'evidence/after-login.png'],
        },
      },
    ],
    decisions: [],
    metrics: { nudgeCount: 0, model: null, runner: null },
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
  };
  const expected = summarizeRunEvidenceSignals(full);
  assert.deepEqual(
    expected.map(({ label }) => label),
    ['Video 1', 'Compare 1'],
  );
  // The served row has lost the step outputs; its signals come from the gateway's summary.
  const served = runListRow(full);
  assert.deepEqual(served.steps[0]?.outputs, {});
  assert.deepEqual(summarizeRunEvidenceSignals(served), expected);
  // A row cached before slim rows has no summary and still carries the step outputs.
  assert.deepEqual(summarizeRunEvidenceSignals(trimRunForList(full)), expected);
});

test('normalizeFamilyEvidenceFilterParam accepts route-safe family evidence filters', () => {
  assert.equal(normalizeFamilyEvidenceFilterParam('videos'), 'videos');
  assert.equal(normalizeFamilyEvidenceFilterParam(['after']), 'after');
  assert.equal(normalizeFamilyEvidenceFilterParam('banana'), null);
  assert.equal(normalizeFamilyEvidenceFilterParam(undefined), null);
});
