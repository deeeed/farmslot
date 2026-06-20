import assert from 'node:assert/strict';
import test from 'node:test';

import type { Run } from '@farmslot/protocol';

import { normalizeFamilyEvidenceFilterParam } from './family-evidence';
import { runEvidenceSignals, summarizeRunEvidenceSignals } from './run-evidence-signals';

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

test('summarizeRunEvidenceSignals uses shared protocol evidence parsing', () => {
  const run = {
    decisions: [],
    liveRecipeContext: {
      artifactManifest: [
        { path: 'evidence/before-login.png', purpose: 'before screenshot' },
        { path: 'evidence/after-login.png', purpose: 'after screenshot' },
      ],
    },
    steps: [
      {
        id: 'recipe',
        title: 'Recipe',
        status: 'completed',
        outputs: { video: 'artifacts/demo-after.mp4' },
      },
    ],
  } as unknown as Pick<Run, 'decisions' | 'steps' | 'liveRecipeContext'>;
  const signals = summarizeRunEvidenceSignals(run);

  assert.equal(signals.find((signal) => signal.kind === 'compare')?.label, 'Compare 1');
  assert.equal(signals.find((signal) => signal.kind === 'video')?.label, 'Video 1');
});

test('normalizeFamilyEvidenceFilterParam accepts route-safe family evidence filters', () => {
  assert.equal(normalizeFamilyEvidenceFilterParam('videos'), 'videos');
  assert.equal(normalizeFamilyEvidenceFilterParam(['after']), 'after');
  assert.equal(normalizeFamilyEvidenceFilterParam('banana'), null);
  assert.equal(normalizeFamilyEvidenceFilterParam(undefined), null);
});
