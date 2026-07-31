import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { CompleteStepOutput } from '@farmslot/protocol';

import { writeResultPackageManifest } from '../evals/package-store.js';
import { createRun, updateRun } from '../runs/store.js';

import {
  executeHumanGateStep,
  executeSelfReviewStep,
  readyGateReviewSubjectMatches,
  shouldSkipRetrospectiveAtComplete,
  updateBranchWorkerSkippedSelfReview,
} from './post-dispatch-steps.js';
import { shouldPrepareLocalFirstPackage } from './publication-policy.js';
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
    shouldSkipRetrospectiveAtComplete(makeRun({ flowType: 'update-branch' })),
    true,
    'update-branch retro belongs after terminal CI-watch, not complete',
  );
  assert.equal(
    shouldSkipRetrospectiveAtComplete(makeRun({ flowType: 'review-pr' })),
    false,
    'review-pr has human-gate but no CI-watch, so complete is terminal',
  );
});

test('executeSelfReviewStep honors a persisted update-branch skip signal', async (t) => {
  const run = createRun({
    flowType: 'update-branch',
    mode: 'autonomous',
    project: 'example-mobile-farm',
    ticketOrPr: 'owner/repo#42',
    runner: 'claude',
    slotId: 'remote-mobile-1',
  });
  updateRun(run.id, {
    steps: run.steps.map((step) =>
      step.name === 'monitor'
        ? {
            ...step,
            status: 'done',
            outputs: {
              workerSignal: { status: 'complete', needsSelfReview: false },
            },
          }
        : step,
    ),
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

  assert.deepEqual(io, {
    inputs: { slotId: 'remote-mobile-1', enabled: false },
    outputs: { skipped: true, reason: 'worker-signal-trivial' },
  });
});

test('updateBranchWorkerSkippedSelfReview requires a done monitor with an explicit skip', () => {
  const run = makeRun({ flowType: 'update-branch' });
  const withMonitor = (
    status: 'running' | 'done',
    workerSignal?: Record<string, unknown> | null,
  ) => ({
    ...run,
    steps: [{ name: 'monitor', status, outputs: { workerSignal } }],
  });

  assert.equal(
    updateBranchWorkerSkippedSelfReview(
      withMonitor('done', { status: 'complete', needsSelfReview: false }),
    ),
    true,
  );
  assert.equal(
    updateBranchWorkerSkippedSelfReview(
      withMonitor('running', { status: 'complete', needsSelfReview: false }),
    ),
    false,
  );
  assert.equal(
    updateBranchWorkerSkippedSelfReview(
      withMonitor('done', { status: 'complete', needsSelfReview: true }),
    ),
    false,
  );
  assert.equal(
    updateBranchWorkerSkippedSelfReview(withMonitor('done', { status: 'complete' })),
    false,
  );
  assert.equal(updateBranchWorkerSkippedSelfReview(withMonitor('done', null)), false);
});

test('executeSelfReviewStep honors the slot signal probe fallback', async (t) => {
  const run = createRun({
    flowType: 'update-branch',
    mode: 'autonomous',
    project: 'example-mobile-farm',
    ticketOrPr: 'owner/repo#43',
    runner: 'claude',
    slotId: 'remote-mobile-1',
  });
  t.after(async () => {
    await deleteTestRunIfPresent(run.id);
  });

  let probeCalls = 0;
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
    probeWorkerSignalForRun: async () => {
      probeCalls += 1;
      return {
        ok: true,
        code: 'ready',
        message: 'ready',
        status: 'complete',
        signal: {
          status: 'complete',
          needsSelfReview: false,
          timestamp: new Date().toISOString(),
        },
      };
    },
    refreshRunLinks: async () => {},
    reviewPlanFromSelection: () => [],
    stepPartialIO: new Map(),
  });

  assert.deepEqual(io, {
    inputs: { slotId: 'remote-mobile-1', enabled: false },
    outputs: { skipped: true, reason: 'worker-signal-trivial' },
  });
  assert.equal(probeCalls, 1);
});

test('local-first complete contract uses gate-held disposition for dev and fix-bug', () => {
  assert.equal(shouldPrepareLocalFirstPackage(makeRun({ flowType: 'fix-bug' })), true);
  assert.equal(
    shouldPrepareLocalFirstPackage(makeRun({ flowType: 'dev', mode: 'autonomous' })),
    true,
  );
  const disposition: CompleteStepOutput['slotDisposition'] = 'gate-held';
  assert.equal(disposition, 'gate-held');
});

test('human-gate can approve a prepared local-first package when slot was detached (replay)', async (t) => {
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

test('review-pr always presents its publication gate in autonomous mode', async (t) => {
  const run = createRun({
    flowType: 'review-pr',
    mode: 'autonomous',
    project: 'example-mobile-farm',
    ticketOrPr: 'example/mobile#123',
    runner: 'grok',
  });
  t.after(async () => {
    await deleteTestRunIfPresent(run.id);
  });

  let reviewGateCalls = 0;
  const io = await executeHumanGateStep(run.id, {
    activeMonitors: new Map(),
    blockedRunError: (message, reason) => new Error(`${reason}: ${message}`),
    broadcastFn: () => {},
    createEngineDecision: async () => 'decision-1',
    executeNoChangeGate: async () => {},
    executePublishGateReviewPlan: async () => [],
    executeReadyGate: async () => 'ready',
    executeReviewGate: async () => {
      reviewGateCalls++;
    },
    getDiffStat: async () => ({ files: 0, additions: 0, deletions: 0 }),
    interactiveLightweightSkipOutputs: () => ({ outputs: { skipped: true } }),
    isHumanGateEnabled: async () => false,
    latestResolvedHumanGateDecision: () => undefined,
    monitorTerminalError: ({ reason }) => new Error(reason),
    refreshRunLinks: async () => {},
    reviewPlanFromSelection: () => [],
    stepPartialIO: new Map(),
  });

  assert.equal(reviewGateCalls, 1);
  assert.deepEqual(io.inputs, { gateType: 'review', gateEnabled: true, forced: false });
  assert.equal(io.outputs?.resolvedAction, null);
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
