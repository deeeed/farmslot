import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import type { Run } from '../../src/contracts/runs.js';
import {
  extractRunArtifactManifest,
  runEvidenceArtifacts,
  summarizeRunEvidence,
} from '../../src/runs/evidence-summary.js';

function run(
  overrides: Partial<Run> = {},
): Pick<Run, 'decisions' | 'steps' | 'output' | 'liveRecipeContext'> {
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
            rawBeforeMetadata: 'artifacts/run.mov',
            artifactManifest: [
              { path: 'artifacts/after-checkout.png', purpose: 'after' },
              { path: 'artifacts/after-checkout.png', purpose: 'after' },
            ],
            recording: {
              path: 'artifacts/run.mov',
              purpose: 'recipe-recording',
              type: 'video',
              sizeBytes: 123,
              sha256: 'abc123',
            },
            repeatedPath: 'artifacts/run.mov',
          },
        },
      ],
    }),
  );

  assert.deepEqual(
    artifacts.map((artifact) => artifact.path),
    ['artifacts/run.mov', 'artifacts/after-checkout.png'],
  );
  const recording = artifacts.find((artifact) => artifact.path === 'artifacts/run.mov');
  assert.equal(recording?.purpose, 'recipe-recording');
  assert.equal(recording?.sizeBytes, 123);
  assert.equal(recording?.sha256, 'abc123');
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

test('captured run output is evidence even when no step lists it; launch diagnostics are not', () => {
  const output = run({
    output: {
      capturedAt: '2026-10-16T00:00:00.000Z',
      workerFinished: true,
      manifestDigest: 'digest',
      reportPath: 'artifacts/report.html',
      artifactManifest: [
        { path: 'artifacts/report.html', purpose: 'report', sizeBytes: 10, sha256: 'r' },
        { path: 'artifacts/cases/login/after.png', purpose: 'screenshot', sha256: 'a' },
        { path: 'artifacts/harness-launch/stdout.log', purpose: 'other' },
      ],
    },
  });

  assert.deepEqual(
    extractRunArtifactManifest(output).map((artifact) => [artifact.path, artifact.purpose]),
    [
      ['artifacts/report.html', 'report'],
      ['artifacts/cases/login/after.png', 'screenshot'],
    ],
  );
  assert.equal(summarizeRunEvidence(output).artifactCount, 2);
});

test('step output prose and host paths are not run artifacts', () => {
  const artifacts = extractRunArtifactManifest(
    run({
      steps: [
        {
          name: 'write-task',
          status: 'done',
          outputs: {
            taskFile: '/home/worker/farm/projects/demo/tasks/qa/run-1/TASK.md',
            subSteps: [{ detail: 'Rendering run-1/CHECKLIST.md' }],
            artifacts: [{ path: 'inputs/handoff.json', purpose: 'handoff' }],
            recording: 'artifacts/run.mov',
          },
        },
      ],
    }),
  );

  assert.deepEqual(
    artifacts.map((artifact) => artifact.path),
    ['inputs/handoff.json', 'artifacts/run.mov'],
  );
});

test('a gate keeps the frozen metadata of a file the run output recaptured', () => {
  const [video] = extractRunArtifactManifest(
    run({
      decisions: [
        {
          id: 'ready',
          type: 'engine_human_gate',
          title: 'Ready',
          description: 'Ready',
          actions: [],
          createdAt: '2026-10-17T00:00:00.000Z',
          payload: {
            kind: 'ready',
            prNumber: 7,
            repo: 'owner/repo',
            diffStat: { files: 1, additions: 1, deletions: 0 },
            workerReport: 'done',
            branch: 'fix/video',
            artifactManifest: [
              { path: 'artifacts/after.mp4', purpose: 'video-after', sha256: 'frozen' },
            ],
          },
        },
      ],
      output: {
        capturedAt: '2026-10-17T00:01:00.000Z',
        workerFinished: true,
        manifestDigest: 'digest',
        artifactManifest: [{ path: 'artifacts/after.mp4', purpose: 'other', sha256: 'recaptured' }],
      },
    }),
  );

  assert.deepEqual([video?.purpose, video?.sha256], ['video-after', 'frozen']);
});
