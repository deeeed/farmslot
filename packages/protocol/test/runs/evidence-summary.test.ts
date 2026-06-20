import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import type { Run } from '../../src/contracts/runs.js';
import { runEvidenceArtifacts, summarizeRunEvidence } from '../../src/runs/evidence-summary.js';

function run(overrides: Partial<Run> = {}): Pick<Run, 'decisions' | 'steps' | 'liveRecipeContext'> {
  return {
    decisions: [],
    steps: [],
    ...overrides,
  };
}

test('run evidence summary counts videos and before after pairs from retained metadata', () => {
  const summary = summarizeRunEvidence(
    run({
      decisions: [
        {
          id: 'ready',
          type: 'monitor_ready_gate',
          title: 'Ready',
          description: 'Ready',
          actions: [],
          createdAt: '2026-06-20T00:00:00.000Z',
          payload: {
            kind: 'ready',
            prNumber: 42,
            repo: 'owner/repo',
            diffStat: { files: 1, additions: 2, deletions: 1 },
            workerReport: 'done',
            branch: 'fix/visuals',
            artifactManifest: [
              { path: 'artifacts/before-login.png', purpose: 'screenshot' },
              { path: 'artifacts/after-login.png', purpose: 'screenshot' },
              { path: 'artifacts/recordings/full-run.webm', purpose: 'recipe-recording' },
            ],
            publicationStatus: 'published_draft',
          },
        },
      ],
    }),
  );

  assert.equal(summary.artifactCount, 3);
  assert.equal(summary.videoCount, 1);
  assert.equal(summary.visualPairCount, 1);
});

test('run evidence artifact collection discovers nested step output paths and dedupes them', () => {
  const artifacts = runEvidenceArtifacts(
    run({
      steps: [
        {
          name: 'recipe',
          status: 'done',
          startedAt: '2026-06-20T00:00:00.000Z',
          completedAt: '2026-06-20T00:01:00.000Z',
          outputs: {
            artifactManifest: [
              { path: 'artifacts/after-checkout.png', purpose: 'after' },
              { path: 'artifacts/after-checkout.png', purpose: 'after' },
            ],
            recording: { path: 'artifacts/run.mov', type: 'video', sizeBytes: 123 },
          },
        },
      ],
    }),
  );

  assert.deepEqual(
    artifacts.map((artifact) => artifact.path),
    ['artifacts/after-checkout.png', 'artifacts/run.mov'],
  );
  assert.equal(artifacts.find((artifact) => artifact.path === 'artifacts/run.mov')?.sizeBytes, 123);
});

test('run evidence summary includes selected live recipe context artifacts', () => {
  const summary = summarizeRunEvidence(
    run({
      liveRecipeContext: {
        source: 'recipe-run-live',
        recipeRunId: 'recipe-run-1',
        artifactRoot: 'artifacts/recipe-runs/recipe-run-1',
        artifactManifest: [
          { path: 'artifacts/recipe-runs/recipe-run-1/full-run.webm', purpose: 'video' },
        ],
        recipeJson: null,
        recipeQualityArtifact: null,
        qualityReport: null,
        workerLearnings: null,
        isStale: false,
        selectionReason: 'latest-run',
      },
    }),
  );

  assert.equal(summary.artifactCount, 1);
  assert.equal(summary.videoCount, 1);
});
