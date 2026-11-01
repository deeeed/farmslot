// @farmslot:serial — creates and removes real JSON under the shared repo `pool/`.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { ReadyGatePayload, ReviewGatePayload, RunDecision } from '@farmslot/protocol';

import { execLocal } from '../core/exec.js';
import { farmslotRoot } from '../fleet/state.js';
import {
  markPreparedPackageStale,
  preparedPackageIsStale,
} from '../run-completion/prepared-package-stale.js';
import { capturePublicationSource } from '../run-completion/publication-source.js';
import { runBundleStore } from '../run-completion/retained-artifacts.js';
import { createRun, getRun, loadAllRuns, persistRunNow, updateRun } from '../runs/store.js';

import {
  ensureCurrentPublishPackage,
  reconcilePublicationPackageForInspection,
  refreshPublishPackage,
  reviewPolicyForPublishPackageRefresh,
  summarizePublishPackageRefreshEvidence,
} from './publish-package-refresh.js';
import { refreshReviewGate } from './review-gate.js';
import { deleteTestRunIfPresent, makeReadyGatePackage, makeRun } from './test-fixtures.js';

test('pending publication reload retains its approved package without reading live source', async (t) => {
  const taskDir = await mkdtemp(path.join(os.tmpdir(), 'approved-package-reload-'));
  const run = createRun({
    flowType: 'dev',
    mode: 'autonomous',
    project: 'recovery',
    ticketOrPr: 'RECOVER-1',
  });
  t.after(async () => {
    await deleteTestRunIfPresent(run.id);
    await rm(taskDir, { recursive: true, force: true });
  });
  const prepared = makeReadyGatePackage({ publicationStatus: 'pending_publish' });
  await mkdir(path.join(taskDir, path.dirname(prepared.artifactPath)), { recursive: true });
  await writeFile(path.join(taskDir, prepared.artifactPath), JSON.stringify(prepared));
  updateRun(run.id, {
    status: 'human-gating',
    taskFile: path.join(taskDir, 'TASK.md'),
    engineState: {
      publishGate: {
        publicationStatus: 'pending_publish',
        packageId: prepared.id,
        packageHash: prepared.packageHash,
        packageArtifactPath: prepared.artifactPath,
      },
    },
  });
  await persistRunNow(getRun(run.id)!, 'approved package reload regression');
  await loadAllRuns();
  assert.equal(JSON.stringify(await ensureCurrentPublishPackage(run.id)), JSON.stringify(prepared));
  assert.equal(getRun(run.id)!.engineState?.publishGate?.publicationStatus, 'pending_publish');

  const store = await runBundleStore(true);
  await writeFile(
    path.join(taskDir, prepared.artifactPath),
    JSON.stringify({
      ...prepared,
      artifactBundle: {
        storeId: store.id,
        bundleDigest: 'a'.repeat(64),
        taskKey: run.id,
        manifestDigest: 'captured-output',
      },
    }),
  );
  await assert.rejects(
    ensureCurrentPublishPackage(run.id),
    /Approved publication package is unavailable/,
  );
  assert.equal(getRun(run.id)!.engineState?.publishGate?.packageHash, prepared.packageHash);
});

test('publish package refresh evidence summary preserves valid selection and reports drops', () => {
  const oldPackage = makeReadyGatePackage({
    evidenceManifest: [
      { path: 'artifacts/before.png', purpose: 'debug-screenshot', sizeBytes: 10 },
      { path: 'artifacts/after.png', purpose: 'debug-screenshot', sizeBytes: 11 },
      { path: 'artifacts/old-video.mp4', purpose: 'debug-video', sizeBytes: 12 },
    ],
  });
  const refreshedPackage = makeReadyGatePackage({
    evidenceManifest: [
      { path: 'artifacts/before.png', purpose: 'debug-screenshot', sizeBytes: 10 },
      { path: 'artifacts/after-new.png', purpose: 'debug-screenshot', sizeBytes: 13 },
    ],
  });

  const summary = summarizePublishPackageRefreshEvidence(oldPackage, refreshedPackage, [
    'artifacts/before.png',
    'artifacts/before.png',
    'artifacts/old-video.mp4',
  ]);

  assert.deepEqual(summary.preservedEvidenceKeys, ['artifacts/before.png']);
  assert.deepEqual(summary.droppedEvidenceKeys, ['artifacts/old-video.mp4']);
  assert.deepEqual(summary.droppedEvidence, [
    {
      key: 'artifacts/old-video.mp4',
      reason: 'missing from refreshed package evidence manifest',
    },
  ]);
  assert.deepEqual(summary.addedEvidenceKeys, ['artifacts/after-new.png']);
});
test('publish package refresh evidence summary uses shared path variants', () => {
  const oldPackage = makeReadyGatePackage({
    evidenceManifest: [
      { path: 'before.png', purpose: 'debug-screenshot', sizeBytes: 10 },
      { path: 'screenshots/after.png', purpose: 'debug-screenshot', sizeBytes: 11 },
    ],
  });
  const refreshedPackage = makeReadyGatePackage({
    evidenceManifest: [
      { path: 'artifacts/before.png', purpose: 'debug-screenshot', sizeBytes: 10 },
      { path: 'artifacts/screenshots/after.png', purpose: 'debug-screenshot', sizeBytes: 11 },
      { path: 'artifacts/screenshots/new.png', purpose: 'debug-screenshot', sizeBytes: 12 },
    ],
  });

  const summary = summarizePublishPackageRefreshEvidence(oldPackage, refreshedPackage, [
    './before.png',
    'after.png',
    'missing.png',
  ]);

  assert.deepEqual(summary.preservedEvidenceKeys, [
    'artifacts/before.png',
    'artifacts/screenshots/after.png',
  ]);
  assert.deepEqual(summary.droppedEvidenceKeys, ['missing.png']);
  assert.deepEqual(summary.addedEvidenceKeys, ['artifacts/screenshots/new.png']);
});

test('reviewPolicyForPublishPackageRefresh drops ad hoc human-gate review requirements', () => {
  const run = makeRun({ flowType: 'dev', mode: 'autonomous' });
  const humanGatePayload = {
    reviewPolicy: {
      minimumReviews: 1,
      requestedBy: 'human-gate' as const,
    },
  };

  assert.deepEqual(reviewPolicyForPublishPackageRefresh(run, undefined, humanGatePayload), {
    minimumReviews: 0,
    requestedBy: 'dispatch',
  });

  const dispatchPayload = {
    reviewPolicy: {
      minimumReviews: 1,
      requestedBy: 'dispatch' as const,
    },
  };
  assert.deepEqual(
    reviewPolicyForPublishPackageRefresh(run, undefined, dispatchPayload),
    dispatchPayload.reviewPolicy,
  );

  const legacyDispatchRun = makeRun({
    engineState: {
      publishGate: {
        reviewSequence: [],
        reviews: [
          {
            reviewerSessionId: 'fixture-session-' + 'review-1',
            reviewedHeadSha: 'fixture-head',
            mode: 'cold' as const,
            id: 'review-1',
            source: 'dispatch',
            loopNumber: 1,
            verdict: 'pass',
            unresolvedCount: 0,
          },
        ],
      },
    },
  });
  const legacyDispatchPayload = {
    reviewPolicy: {
      minimumReviews: 1,
      requestedBy: 'dispatch' as const,
    },
  };
  assert.deepEqual(
    reviewPolicyForPublishPackageRefresh(legacyDispatchRun, undefined, legacyDispatchPayload),
    { ...legacyDispatchPayload.reviewPolicy },
  );
});

test('refreshPublishPackage fails closed when worker artifacts cannot be mirrored', async (t) => {
  const testId = `refresh-package-fail-${process.pid}-${Date.now()}`;
  const poolFile = path.join(farmslotRoot, 'pool', `${testId}.json`);
  const workerRepo = await mkdtemp(path.join(os.tmpdir(), `${testId}-worker-`));
  const taskRoot = path.join(farmslotRoot, '.sandbox/farmslot-farm/tasks');
  const taskRelDir = `test/${testId}`;
  const taskDir = path.join(taskRoot, taskRelDir);
  const taskFile = path.join(taskDir, 'TASK.md');
  const slotId = `${testId}-slot`;
  t.after(async () => {
    await deleteTestRunIfPresent(run.id);
    await rm(taskDir, { recursive: true, force: true });
    await rm(workerRepo, { recursive: true, force: true });
    await rm(poolFile, { force: true });
  });

  await mkdir(taskDir, { recursive: true });
  await mkdir(path.join(taskDir, 'artifacts/review-1/review-loop-1'), {
    recursive: true,
  });
  const workerTaskDir = path.join(workerRepo, '.sandbox/farmslot-farm/worker-task', taskRelDir);
  await mkdir(path.join(workerTaskDir, 'artifacts'), { recursive: true });
  await writeFile(taskFile, '# refresh package fail test\n');
  const preservedReviewDiff = path.join(taskDir, 'artifacts/review-1/review-loop-1/review.diff');
  await writeFile(preservedReviewDiff, 'preserved review diff\n');
  await writeFile(path.join(workerRepo, 'README.md'), 'worker repo\n');
  await execLocal(
    'git init -b main && git config user.email test@example.com && git config user.name Test && git add . && git commit -m initial',
    {
      cwd: workerRepo,
    },
  );
  await writeFile(
    poolFile,
    JSON.stringify(
      {
        machine: 'localhost',
        project: 'farmslot-farm',
        platform: 'cli',
        os: 'darwin',
        host: 'localhost',
        ssh_user: os.userInfo().username,
        slots: [{ id: slotId, enabled: true, repo: workerRepo, session: slotId }],
      },
      null,
      2,
    ),
  );
  const oldPackage = makeReadyGatePackage();
  const decision: RunDecision = {
    id: 'ready-decision-1',
    type: 'engine_human_gate',
    title: 'Ready',
    description: 'Ready',
    actions: [{ id: 'approve-publish', label: 'Approve Publish', style: 'primary' }],
    createdAt: '2026-05-17T00:00:00.000Z',
    payload: { kind: 'ready', prPackage: oldPackage } as ReadyGatePayload,
  };
  const run = createRun({
    flowType: 'dev',
    mode: 'autonomous',
    project: 'farmslot-farm',
    ticketOrPr: 'PROJ-REFRESH-FAIL',
    runner: 'codex',
  });
  updateRun(run.id, {
    slotId,
    taskFile,
    branch: 'main',
    decisions: [decision],
    engineState: { publishGate: { publicationStatus: 'not_published', reviews: [] } },
  });

  await assert.rejects(
    () =>
      refreshPublishPackage(
        {
          runId: run.id,
          decisionId: decision.id,
          selectedEvidenceKeys: [],
          publicationTarget: 'ready',
        },
        {
          progress: async () => ({ kind: 'idle' }),
          source: (current) =>
            capturePublicationSource(current, {
              slot: async () => ({ current_run_id: current.id, slot_epoch: 1 }),
            }),
        },
      ),
    /Artifact mirror refresh failed; cannot build an authoritative publish package/,
  );
  assert.equal((await stat(preservedReviewDiff)).isFile(), true);
});
test('refreshReviewGate does not let worker artifacts overwrite gateway-owned package state', async (t) => {
  const testId = `refresh-review-gateway-owned-${process.pid}-${Date.now()}`;
  const poolFile = path.join(farmslotRoot, 'pool', `${testId}.json`);
  const workerRepo = await mkdtemp(path.join(os.tmpdir(), `${testId}-worker-`));
  const taskRoot = path.join(farmslotRoot, '.sandbox/farmslot-farm/tasks');
  const taskRelDir = `test/${testId}`;
  const taskDir = path.join(taskRoot, taskRelDir);
  const workerTaskDir = path.join(workerRepo, '.sandbox/farmslot-farm/worker-task', taskRelDir);
  const taskFile = path.join(taskDir, 'TASK.md');
  const slotId = `${testId}-slot`;
  t.after(async () => {
    await deleteTestRunIfPresent(run.id);
    await rm(taskDir, { recursive: true, force: true });
    await rm(workerRepo, { recursive: true, force: true });
    await rm(poolFile, { force: true });
  });

  await mkdir(path.join(taskDir, 'artifacts/review-loop-1'), { recursive: true });
  await mkdir(path.join(workerTaskDir, 'artifacts/review-loop-1'), { recursive: true });
  await writeFile(taskFile, '# refresh review gate\n');
  await writeFile(path.join(taskDir, 'artifacts/pr-package.json'), '{"owner":"gateway"}\n');
  await writeFile(path.join(taskDir, 'artifacts/review-loop-1/review.diff'), 'gateway diff\n');
  await writeFile(path.join(workerTaskDir, 'TASK.md'), '# worker task\n');
  await writeFile(
    path.join(workerTaskDir, 'artifacts/review.md'),
    'Recommendation: APPROVE\n\n## Summary\nWorker review updated\n',
  );
  await writeFile(path.join(workerTaskDir, 'artifacts/line-comments.json'), '[]\n');
  await writeFile(
    path.join(workerTaskDir, 'artifacts/review-result.json'),
    JSON.stringify({ schemaVersion: 1, verdict: 'pass', recommendation: 'APPROVE', issues: [] }),
  );
  await writeFile(path.join(workerTaskDir, 'artifacts/pr-package.json'), '{"owner":"worker"}\n');
  await writeFile(path.join(workerTaskDir, 'artifacts/review-loop-1/review.diff'), 'worker diff\n');
  await writeFile(
    poolFile,
    JSON.stringify(
      {
        machine: 'localhost',
        project: 'farmslot-farm',
        platform: 'cli',
        os: 'darwin',
        host: 'localhost',
        ssh_user: os.userInfo().username,
        slots: [{ id: slotId, enabled: true, repo: workerRepo, session: slotId }],
      },
      null,
      2,
    ),
  );

  const run = createRun({
    flowType: 'review-pr',
    mode: 'interactive',
    project: 'farmslot-farm',
    ticketOrPr: '123',
    runner: 'codex',
  });
  updateRun(run.id, {
    slotId,
    taskFile,
    decisions: [
      {
        id: 'review-decision-1',
        type: 'engine_review_posting',
        title: 'Review',
        description: 'Review',
        actions: [{ id: 'approve', label: 'Approve', style: 'primary' }],
        createdAt: '2026-05-17T00:00:00.000Z',
        payload: {
          kind: 'review',
          prNumber: 123,
          repo: null,
          recommendation: 'COMMENT',
          reviewMd: '',
          lineComments: [],
        } satisfies ReviewGatePayload,
      },
    ],
  });

  const refreshed = await refreshReviewGate(run.id);
  const decision = refreshed.decisions[0];
  assert.equal((decision.payload as ReviewGatePayload).reviewMd?.includes('Worker review'), true);
  assert.equal(
    await readFile(path.join(taskDir, 'artifacts/pr-package.json'), 'utf-8'),
    '{"owner":"gateway"}\n',
  );
  assert.equal(
    await readFile(path.join(taskDir, 'artifacts/review-loop-1/review.diff'), 'utf-8'),
    'gateway diff\n',
  );
});

test('inspection repairs a missing bundle at unchanged HEAD, defers busy work and coalesces refresh', async (t) => {
  const run = createRun({
    flowType: 'dev',
    mode: 'autonomous',
    project: 'inspection',
    ticketOrPr: 'INSPECT-1',
  });
  t.after(() => deleteTestRunIfPresent(run.id));
  const prepared = makeReadyGatePackage();
  const decision: RunDecision = {
    id: 'inspect',
    type: 'engine_human_gate',
    title: 'Gate',
    description: '',
    createdAt: prepared.createdAt,
    actions: [
      { id: 'approve-publish', label: 'Approve', style: 'primary' },
      { id: 'hold', label: 'Hold', style: 'secondary' },
    ],
    payload: {
      kind: 'ready',
      prNumber: null,
      repo: null,
      branch: prepared.branch,
      workerReport: '',
      diffStat: prepared.diffStat,
      prPackage: prepared,
    },
  };
  updateRun(run.id, { status: 'human-gating', decisions: [decision] });
  let missingBundleRefreshes = 0;
  const missingBundleReaders = {
    head: async () => prepared.headSha ?? null,
    bundleAvailable: async () => false,
    progress: async () => ({ kind: 'idle' as const }),
    refresh: async () => {
      missingBundleRefreshes++;
      return getRun(run.id)!;
    },
  };
  await reconcilePublicationPackageForInspection(getRun(run.id)!, missingBundleReaders);
  assert.equal(missingBundleRefreshes, 1);
  assert.deepEqual(getRun(run.id)!.decisions, [decision]);
  const readers = {
    head: async () => 'new-head',
    progress: async () => ({ kind: 'making-progress' as const }),
    refresh: async () => assert.fail('must wait for idle'),
  };
  const collecting = await reconcilePublicationPackageForInspection(getRun(run.id)!, readers);
  assert.deepEqual(
    collecting.decisions[0].actions.map((action) => action.id),
    ['hold'],
  );
  assert.equal(
    collecting.decisions[0].payload?.kind === 'ready' &&
      collecting.decisions[0].payload.gateReadiness?.state,
    'collecting',
  );
  assert.deepEqual(getRun(run.id)!.decisions, [decision]);
  let calls = 0;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const idleReaders = {
    ...readers,
    progress: async () => ({ kind: 'idle' as const }),
    refresh: async () => {
      calls++;
      await barrier;
      return getRun(run.id)!;
    },
  };
  const first = reconcilePublicationPackageForInspection(getRun(run.id)!, idleReaders);
  const second = reconcilePublicationPackageForInspection(getRun(run.id)!, idleReaders);
  assert.equal(first, second);
  release();
  await first;
  assert.equal(calls, 1);
  const failed = await reconcilePublicationPackageForInspection(getRun(run.id)!, {
    ...idleReaders,
    refresh: async () => {
      throw new Error('Source lease changed');
    },
  });
  assert.match(failed.decisions[0].description, /Source lease changed/);
  assert.deepEqual(
    failed.decisions[0].actions.map((action) => action.id),
    ['hold'],
  );
  assert.deepEqual(getRun(run.id)!.decisions, [decision]);
});

test('a package marked stale by refused evidence is refreshed, not shown again, at the same HEAD', async (t) => {
  const run = createRun({
    flowType: 'dev',
    mode: 'autonomous',
    project: 'inspection',
    ticketOrPr: 'INSPECT-STALE',
  });
  t.after(() => deleteTestRunIfPresent(run.id));
  const prepared = makeReadyGatePackage();
  const decision: RunDecision = {
    id: 'stale',
    type: 'engine_human_gate',
    title: 'Gate',
    description: '',
    createdAt: prepared.createdAt,
    actions: [{ id: 'approve-publish', label: 'Approve', style: 'primary' }],
    payload: {
      kind: 'ready',
      prNumber: null,
      repo: null,
      branch: prepared.branch,
      workerReport: '',
      diffStat: prepared.diffStat,
      prPackage: prepared,
    },
  };
  updateRun(run.id, { status: 'human-gating', decisions: [decision] });
  let refreshes = 0;
  const readers = {
    head: async () => prepared.headSha ?? null,
    bundleAvailable: async () => true,
    progress: async () => ({ kind: 'idle' as const }),
    refresh: async () => {
      refreshes++;
      throw new Error('Before evidence comes from recipe attempt recipe-runs/attempts/base');
    },
  };
  await reconcilePublicationPackageForInspection(getRun(run.id)!, readers);
  assert.equal(refreshes, 0, 'an unchanged package is shown as is');
  // A human-gate replay's mirror refresh refused the worker's evidence after this package.
  updateRun(run.id, { engineState: { publishGate: { packageId: prepared.id } } });
  await markPreparedPackageStale(run.id);
  const shown = await reconcilePublicationPackageForInspection(getRun(run.id)!, readers);
  assert.equal(refreshes, 1);
  assert.deepEqual(
    shown.decisions[0].actions.map((action) => action.id),
    [],
    'the stale package cannot be approved',
  );
  assert.match(shown.decisions[0].description, /Before evidence comes from recipe attempt/);
});

test('a refused package stays stale, across a restart, until another package replaces it', async (t) => {
  const run = createRun({
    flowType: 'dev',
    mode: 'autonomous',
    project: 'inspection',
    ticketOrPr: 'INSPECT-STALE-2',
  });
  t.after(() => deleteTestRunIfPresent(run.id));
  updateRun(run.id, { engineState: { publishGate: { packageId: 'pkg-old' } } });
  assert.equal(preparedPackageIsStale(getRun(run.id)!), false);
  await markPreparedPackageStale(run.id);
  // Durable: the run record names the refused package, so a restarted gateway reads it too.
  assert.equal(getRun(run.id)!.engineState?.publishGate?.refusedEvidencePackageId, 'pkg-old');
  assert.equal(preparedPackageIsStale(getRun(run.id)!), true);
  // A package built after the refusal is not stale.
  updateRun(run.id, {
    engineState: {
      publishGate: { ...getRun(run.id)!.engineState!.publishGate, packageId: 'pkg-new' },
    },
  });
  assert.equal(preparedPackageIsStale(getRun(run.id)!), false);
});
