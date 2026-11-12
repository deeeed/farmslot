import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import type { Run } from '../../src/contracts/runs.js';
import { isPublishEvidenceArtifact } from '../../src/recipes/step-io.js';
import {
  extractRunArtifactManifest,
  isRunArtifactImagePath,
  isRunArtifactMediaPath,
  runEvidenceArtifacts,
  type RunEvidenceSummary,
  runListEvidenceSummary,
  summarizeRunEvidence,
} from '../../src/runs/evidence-summary.js';
import { runListRow, trimRunForList } from '../../src/runs/list-trim.js';

const zeroSummary: RunEvidenceSummary = {
  artifactCount: 0,
  videoCount: 0,
  visualPairCount: 0,
  catalogCounts: {
    artifactCount: 0,
    artifactBytes: 0,
    visualEvidenceCount: 0,
    validationEvidenceCount: 0,
    reviewEvidenceCount: 0,
  },
};

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
            // A path that leaves the run directory is not one; a name that only holds dots is.
            escaped: '../outside/notes.md',
            ranged: 'artifacts/v1..v2.diff',
          },
        },
      ],
    }),
  );

  assert.deepEqual(
    artifacts.map((artifact) => artifact.path),
    ['inputs/handoff.json', 'artifacts/run.mov', 'artifacts/v1..v2.diff'],
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

test('summarizeRunEvidence computes diffStat and per-purpose evidence counts from step outputs', () => {
  const fullRun = run({
    steps: [
      {
        name: 'work',
        status: 'done',
        startedAt: '2026-11-01T00:00:00.000Z',
        completedAt: '2026-11-01T00:01:00.000Z',
        outputs: {
          diffStat: { files: 3, additions: 20, deletions: 5 },
          artifacts: [
            { path: 'screenshots/after.png', purpose: 'screenshot', sizeBytes: 500 },
            { path: 'reports/recipe-report.md', purpose: 'report', sizeBytes: 100 },
            { path: 'reviews/final-review.md', purpose: 'review', sizeBytes: 200 },
          ],
        },
      },
    ],
  });

  const summary = summarizeRunEvidence(fullRun);

  assert.deepEqual(summary.diffStat, { files: 3, additions: 20, deletions: 5 });
  // The eval catalog's counts of the step-output artifacts: one visual (the screenshot), one
  // validation (the report), one review.
  assert.deepEqual(summary.catalogCounts, {
    artifactCount: 3,
    artifactBytes: 800,
    visualEvidenceCount: 1,
    validationEvidenceCount: 1,
    reviewEvidenceCount: 1,
  });
  assert.equal(summary.artifactCount, 3);
});

test('summarizeRunEvidence always computes from what the run carries, even with a summary key', () => {
  const stored = run({
    steps: [{ name: 'work', status: 'done', outputs: { video: 'artifacts/demo-after.mp4' } }],
  });
  const expected = summarizeRunEvidence(stored);
  assert.equal(expected.videoCount, 1);
  // A stored run object that picked up the served-only key, empty or not, is still computed.
  const emptyKey = { ...stored, evidenceSummary: undefined };
  const staleKey = { ...stored, evidenceSummary: zeroSummary };
  assert.deepEqual(summarizeRunEvidence(emptyKey), expected);
  assert.deepEqual(summarizeRunEvidence(staleKey), expected);
});

test('runListEvidenceSummary uses the served summary and computes when the row has none', () => {
  const row = {
    decisions: [],
    steps: [{ name: 'work', status: 'done' as const, outputs: { video: 'artifacts/demo.mp4' } }],
  };
  const served: RunEvidenceSummary = { ...zeroSummary, artifactCount: 7, videoCount: 2 };
  assert.strictEqual(runListEvidenceSummary({ ...row, evidenceSummary: served }), served);
  // A row cached before the gateway served summaries, or one whose key is present but empty.
  assert.equal(runListEvidenceSummary(row).videoCount, 1);
  assert.equal(runListEvidenceSummary({ ...row, evidenceSummary: undefined }).videoCount, 1);
});

test('WebP stills are inline images and publishable media, beside retained PNG stills', () => {
  for (const still of ['stills/a.webp', 'stills/B.WEBP', 'stills/old.png']) {
    assert.equal(isRunArtifactImagePath(still), true, still);
    assert.equal(isRunArtifactMediaPath(still), true, still);
    assert.equal(isPublishEvidenceArtifact({ path: still, purpose: 'screenshot' }), true, still);
  }
  assert.equal(isRunArtifactMediaPath('videos/run.mp4'), true);
  assert.equal(isRunArtifactImagePath('videos/run.mp4'), false);
  assert.equal(isRunArtifactMediaPath('report.json'), false);
  assert.equal(isRunArtifactMediaPath('stills/a.webp.json'), false);
});

// The Companion runs list opens its Diff button on the summary's diff file: the served row,
// the full run and an old cached row name the same one.
test('the served summary names the same diff file as the full run and an old cached row', () => {
  const full: Run = {
    id: 'diff-run',
    familyId: 'diff-family',
    lane: 'production',
    flowType: 'fix-bug',
    status: 'done',
    project: 'demo',
    ticketOrPr: 'DEMO-3',
    slotId: null,
    branch: null,
    taskFile: null,
    steps: [
      {
        name: 'work',
        status: 'done',
        outputs: { screenshots: ['evidence/before-home.png', 'evidence/after-home.png'] },
      },
      { name: 'recipe', status: 'done', outputs: { patch: 'artifacts/changes.patch' } },
    ],
    decisions: [
      {
        id: 'gate',
        type: 'engine_human_gate',
        title: 'Publish',
        description: '',
        createdAt: '2026-11-01T00:00:00.000Z',
        actions: [],
        payload: {
          kind: 'ready',
          prNumber: null,
          repo: null,
          branch: 'fix/diff',
          workerReport: 'done',
          diffStat: { files: 1, additions: 1, deletions: 0 },
          artifactManifest: [
            { path: 'artifacts/diff.txt', purpose: 'diff' },
            { path: 'evidence/after-settings.png', purpose: 'after screenshot' },
          ],
        },
      },
    ],
    metrics: { nudgeCount: 0, model: null, runner: null },
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
  };
  const expected = summarizeRunEvidence(full).diffArtifactPath;
  assert.equal(expected, 'artifacts/diff.txt');
  assert.equal(runListEvidenceSummary(runListRow(full)).diffArtifactPath, expected);
  assert.equal(runListEvidenceSummary(trimRunForList(full)).diffArtifactPath, expected);
  // A run with no diff or visual artifacts names none.
  assert.equal(
    summarizeRunEvidence({ ...full, steps: [], decisions: [] }).diffArtifactPath,
    undefined,
  );
});
