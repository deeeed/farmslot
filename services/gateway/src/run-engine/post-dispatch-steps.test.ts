import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { writeResultPackageManifest } from '../evals/package-store.js';
import { createRun, updateRun } from '../runs/store.js';

import {
  executeHumanGateStep,
  executeSelfReviewStep,
  readyGateReviewSubjectMatches,
  shouldSkipRetrospectiveAtComplete,
} from './post-dispatch-steps.js';
import {
  deleteTestRunIfPresent,
  makeEvalResultPackage,
  makeReadyGatePackage,
  makeRun,
} from './test-fixtures.js';

test('complete-step retrospective gating defers only CI-watch flows', () => {
  assert.equal(
    shouldSkipRetrospectiveAtComplete(makeRun({ flowType: 'fix-bug' })),
    true,
    'fix-bug retro belongs after terminal CI-watch, not complete',
  );
  assert.equal(
    shouldSkipRetrospectiveAtComplete(makeRun({ flowType: 'dev' })),
    true,
    'dev retro belongs after terminal CI-watch, not complete',
  );
  assert.equal(
    shouldSkipRetrospectiveAtComplete(makeRun({ flowType: 'merge-main' })),
    true,
    'merge-main retro belongs after terminal CI-watch, not complete',
  );
  assert.equal(
    shouldSkipRetrospectiveAtComplete(makeRun({ flowType: 'review-pr' })),
    false,
    'review-pr has human-gate but no CI-watch, so complete is terminal',
  );
});



test('human-gate can approve a prepared local-first package after the slot was released', async (t) => {
  const run = createRun({
    flowType: 'dev',
    mode: 'autonomous',
    project: 'example-mobile-farm',
    ticketOrPr: 'PROJ-READY',
    runner: 'grok',
    engineState: {
      publishGate: {
        publicationTarget: 'ready',
        publicationStatus: 'not_published',
      },
    },
  });
  updateRun(run.id, { slotId: null });
  t.after(async () => {
    await deleteTestRunIfPresent(run.id);
  });

  let markedSlot = false;
  const io = await executeHumanGateStep(run.id, {
    activeMonitors: new Map(),
    blockedRunError: (message, reason) => new Error(`${reason}: ${message}`),
    broadcastFn: () => {
      markedSlot = true;
    },
    createEngineDecision: async () => 'decision-1',
    executeNoChangeGate: async () => {},
    executePublishGateReviewPlan: async () => {
      throw new Error('static ready gate should not request a live review slot');
    },
    executeReadyGate: async () => 'ready',
    executeReviewGate: async () => {},
    getDiffStat: async () => ({ files: 1, additions: 2, deletions: 0 }),
    interactiveLightweightSkipOutputs: () => ({ outputs: { skipped: true } }),
    isHumanGateEnabled: async () => true,
    latestResolvedHumanGateDecision: () => undefined,
    monitorTerminalError: ({ reason }) => new Error(reason),
    refreshRunLinks: async () => {},
    reviewPlanFromSelection: () => [],
    stepPartialIO: new Map(),
  });

  assert.equal(markedSlot, false, 'released-slot human gate must not mutate fleet state');
  assert.deepEqual(io.inputs, { gateType: 'ready', gateEnabled: true, forced: false });
  assert.equal(io.outputs?.resolvedAction, null);
  assert.equal(typeof io.outputs?.waitDurationMs, 'number');
});

test('readyGateReviewSubjectMatches ignores review-loop metadata but rejects subject drift', () => {
  const reviewed = makeReadyGatePackage({
    headSha: 'head-1',
    packageInputHash: 'input-1',
    reviewSubjectHash: 'subject-1',
    reviewArtifactIds: ['review-before'],
    reviewDepth: {
      minimumIndependentReviews: 1,
      requireCrossRunner: true,
      extraLoopsRequested: 1,
      requestedBy: 'dispatch',
    },
  });
  assert.equal(
    readyGateReviewSubjectMatches(
      reviewed,
      makeReadyGatePackage({
        headSha: 'head-1',
        packageInputHash: 'input-2',
        reviewSubjectHash: 'subject-2',
        reviewArtifactIds: ['review-after'],
        reviewDepth: {
          minimumIndependentReviews: 1,
          requireCrossRunner: true,
          extraLoopsRequested: 2,
          requestedBy: 'human-gate',
        },
      }),
    ),
    true,
  );
  assert.equal(
    readyGateReviewSubjectMatches(reviewed, {
      ...reviewed,
      selectedEvidenceKeys: ['artifacts/new-after.png'],
    }),
    false,
  );
  assert.equal(readyGateReviewSubjectMatches(reviewed, { ...reviewed, headSha: 'head-2' }), false);
  assert.equal(readyGateReviewSubjectMatches(undefined, reviewed), false);
  assert.equal(readyGateReviewSubjectMatches({ ...reviewed, headSha: undefined }, reviewed), false);
  assert.equal(
    readyGateReviewSubjectMatches(
      makeReadyGatePackage({
        headSha: 'head-1',
        selectedEvidenceKeys: ['artifacts/after.png'],
        evidenceManifest: [
          { path: 'artifacts/after.png', purpose: 'screenshot', sizeBytes: 123 },
          { path: 'artifacts/log.json', purpose: 'other', sizeBytes: 456 },
        ],
      }),
      makeReadyGatePackage({
        headSha: 'head-1',
        selectedEvidenceKeys: ['artifacts/after.png'],
        evidenceManifest: [
          {
            path: 'artifacts/after.png',
            purpose: 'screenshot',
            sizeBytes: 123,
            sha256: 'digest-added-after-review',
          },
        ],
      }),
    ),
    true,
  );
  assert.equal(
    readyGateReviewSubjectMatches(
      makeReadyGatePackage({
        headSha: 'head-1',
        selectedEvidenceKeys: ['after.png'],
        evidenceManifest: [
          {
            path: 'artifacts/after.png',
            purpose: 'screenshot',
            sizeBytes: 123,
          },
        ],
      }),
      makeReadyGatePackage({
        headSha: 'head-1',
        selectedEvidenceKeys: ['artifacts/after.png'],
        evidenceManifest: [
          {
            path: 'artifacts/after.png',
            purpose: 'screenshot',
            sizeBytes: 123,
            sha256: 'digest-added-after-review',
          },
        ],
      }),
    ),
    true,
  );
  assert.equal(
    readyGateReviewSubjectMatches(
      makeReadyGatePackage({
        headSha: 'head-1',
        selectedEvidenceKeys: ['artifacts/after.png'],
        evidenceManifest: [
          {
            path: 'artifacts/after.png',
            purpose: 'screenshot',
            sizeBytes: 123,
            sha256: 'digest-a',
          },
        ],
      }),
      makeReadyGatePackage({
        headSha: 'head-1',
        selectedEvidenceKeys: ['artifacts/after.png'],
        evidenceManifest: [
          {
            path: 'artifacts/after.png',
            purpose: 'screenshot',
            sizeBytes: 123,
            sha256: 'digest-b',
          },
        ],
      }),
    ),
    false,
  );
});
test('executeSelfReviewStep skips eval packages with review axis none', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'farmslot-review-axis-skip-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const packagePath = path.join(root, 'candidate.result-package.json');
  await writeResultPackageManifest(
    packagePath,
    makeEvalResultPackage({
      axes: {
        template: { path: 'templates/worker/fix-bug.md' },
        review: { name: 'none', version: 'first-pass' },
      },
    }),
  );

  const run = createRun({
    flowType: 'fix-bug',
    mode: 'autonomous',
    project: 'example-mobile-farm',
    ticketOrPr: 'EVAL-REVIEW-SKIP',
    runner: 'codex',
    slotId: 'runner-mobile-1',
    completionPolicy: 'artifact-only',
    engineState: {
      evalExperiment: {
        experimentId: 'experiment-review-skip',
        experimentKey: 'experiment-key-review-skip',
        experimentManifestPath: path.join(root, 'experiment-manifest.json'),
        packagePath,
        candidateStrategyFingerprint: 'fingerprint-review-skip',
        trialId: 'trial-review-skip',
      },
    },
  });
  t.after(async () => {
    await deleteTestRunIfPresent(run.id);
  });

  const io = await executeSelfReviewStep(run.id, {
    activeMonitors: new Map(),
    blockedRunError: (message, reason) => new Error(`${reason}: ${message}`),
    broadcastFn: () => {},
    createEngineDecision: async () => 'decision-1',
    executeNoChangeGate: async () => {},
    executePublishGateReviewPlan: async () => [],
    executeReadyGate: async () => 'ready',
    executeReviewGate: async () => {},
    getDiffStat: async () => ({ files: 0, additions: 0, deletions: 0 }),
    interactiveLightweightSkipOutputs: () => ({ outputs: { skipped: true } }),
    isHumanGateEnabled: async () => false,
    latestResolvedHumanGateDecision: () => undefined,
    monitorTerminalError: ({ reason }) => new Error(reason),
    refreshRunLinks: async () => {},
    reviewPlanFromSelection: () => [],
    stepPartialIO: new Map(),
  });

  assert.deepEqual(io.inputs, {
    slotId: 'runner-mobile-1',
    enabled: false,
    reviewAxis: { name: 'none', version: 'first-pass' },
  });
  assert.deepEqual(io.outputs, {
    skipped: true,
    reason: 'eval-review-axis-none',
    reviewAxis: { name: 'none', version: 'first-pass' },
  });
});
