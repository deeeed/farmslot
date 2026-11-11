import assert from 'node:assert/strict';
import test from 'node:test';

import type { Run, RunEvidenceSummary } from '@farmslot/protocol';

import { normalizeFamilyEvidenceFilterParam } from './family-evidence';
import {
  runEvidenceSignalRouteTarget,
  runEvidenceSignals,
  summarizeRunEvidenceSignals,
} from './run-evidence-signals';

test('runEvidenceSignals exposes video and compare signal labels', () => {
  assert.deepEqual(runEvidenceSignals({ artifactCount: 4, videoCount: 1, visualPairCount: 2 }), [
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
  ]);
  assert.deepEqual(runEvidenceSignals({ artifactCount: 0, videoCount: 0, visualPairCount: 0 }), []);
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

test('summarizeRunEvidenceSignals uses pre-computed evidenceSummary on slim rows', () => {
  // A slim row has evidenceSummary set by the gateway; evidence signals should use it directly
  // without walking decisions/steps, so a row with no decisions/steps still returns correct signals.
  const slimRun: Pick<Run, 'steps' | 'liveRecipeContext'> & {
    decisions?: ReadonlyArray<{ payload?: unknown }>;
    evidenceSummary: RunEvidenceSummary;
  } = {
    decisions: [],
    steps: [],
    liveRecipeContext: null,
    evidenceSummary: { artifactCount: 5, videoCount: 2, visualPairCount: 3 },
  };
  const signals = summarizeRunEvidenceSignals(slimRun);
  assert.equal(
    signals.find((s) => s.kind === 'video')?.count,
    2,
    'videoCount from evidenceSummary',
  );
  assert.equal(
    signals.find((s) => s.kind === 'compare')?.count,
    3,
    'visualPairCount from evidenceSummary',
  );

  // An old fat row without evidenceSummary falls back to computing from content.
  const fatRun: Pick<Run, 'decisions' | 'steps' | 'liveRecipeContext'> = {
    decisions: [],
    steps: [],
    liveRecipeContext: null,
  };
  const fatSignals = summarizeRunEvidenceSignals(fatRun);
  assert.deepEqual(fatSignals, [], 'fat row with no artifacts returns empty signals');
});

test('normalizeFamilyEvidenceFilterParam accepts route-safe family evidence filters', () => {
  assert.equal(normalizeFamilyEvidenceFilterParam('videos'), 'videos');
  assert.equal(normalizeFamilyEvidenceFilterParam(['after']), 'after');
  assert.equal(normalizeFamilyEvidenceFilterParam('banana'), null);
  assert.equal(normalizeFamilyEvidenceFilterParam(undefined), null);
});
