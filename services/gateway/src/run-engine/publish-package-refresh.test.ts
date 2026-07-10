import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type {
  ReadyGatePayload,
  ReadyGatePrPackage,
  ReviewGatePayload,
  RunDecision,
} from '@farmslot/protocol';

import { execLocal } from '../core/exec.js';
import { farmslotRoot } from '../fleet/state.js';
import { createRun, getRun, updateRun } from '../runs/store.js';

import {
  refreshPublishPackage,
  reviewDepthForPublishPackageRefresh,
  summarizePublishPackageRefreshEvidence,
} from './publish-package-refresh.js';
import { refreshReviewGate } from './review-gate.js';
import { deleteTestRunIfPresent, makeReadyGatePackage, makeRun } from './test-fixtures.js';

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

test('reviewDepthForPublishPackageRefresh drops ad hoc human-gate review requirements', () => {
  const run = makeRun({ flowType: 'dev', mode: 'autonomous' });
  const humanGatePayload = {
    reviewDepth: {
      minimumIndependentReviews: 1,
      requireCrossRunner: true,
      extraLoopsRequested: 0,
      requestedBy: 'human-gate' as const,
    },
  };

  assert.deepEqual(reviewDepthForPublishPackageRefresh(run, undefined, humanGatePayload), {
    minimumIndependentReviews: 0,
    requireCrossRunner: false,
    extraLoopsRequested: 0,
    requestedBy: 'dispatch',
  });

  const dispatchPayload = {
    reviewDepth: {
      minimumIndependentReviews: 1,
      requireCrossRunner: false,
      extraLoopsRequested: 0,
      requestedBy: 'dispatch' as const,
    },
  };
  assert.deepEqual(
    reviewDepthForPublishPackageRefresh(run, undefined, dispatchPayload),
    dispatchPayload.reviewDepth,
  );
});

test('refreshPublishPackage rebuilds the pending package and preserves safe operator choices', async (t) => {
  const testId = `refresh-package-${process.pid}-${Date.now()}`;
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

  await mkdir(path.join(workerTaskDir, 'artifacts/screenshots'), { recursive: true });
  await mkdir(path.join(taskDir, 'artifacts'), { recursive: true });
  await mkdir(path.join(taskDir, 'artifacts/independent-review-2/review-loop-1'), {
    recursive: true,
  });
  await mkdir(path.join(taskDir, 'artifacts/review-loop-1'), { recursive: true });
  await writeFile(path.join(taskDir, 'TASK.md'), '# refresh package test\n');
  await writeFile(
    path.join(taskDir, 'artifacts/independent-review-2/review-loop-1/review.diff'),
    'review diff\n',
  );
  await writeFile(path.join(taskDir, 'artifacts/review-loop-1/self-review.md'), 'self review\n');
  await writeFile(path.join(workerTaskDir, 'TASK.md'), '# refresh package test\n');
  await writeFile(path.join(workerTaskDir, 'artifacts/report.md'), 'Worker report\n');
  await writeFile(
    path.join(workerTaskDir, 'artifacts/pr-description.md'),
    '## Summary\nRefreshed body\n',
  );
  await writeFile(path.join(workerTaskDir, 'artifacts/validation-summary.md'), 'Validation ok\n');
  await writeFile(path.join(workerTaskDir, 'artifacts/keep.png'), 'keep-v1');
  await writeFile(path.join(workerTaskDir, 'artifacts/after-new.png'), 'after-v1');
  await writeFile(path.join(workerTaskDir, 'artifacts/redundant.png'), 'omit-me');
  await writeFile(
    path.join(workerTaskDir, 'artifacts/screenshots/manifest-proof.png'),
    'manifest-proof-v1',
  );
  await writeFile(
    path.join(workerTaskDir, 'artifacts/evidence-manifest.json'),
    JSON.stringify({
      version: 1,
      preferred_mode: 'screenshots',
      standalone: [
        { label: 'Kept', file: 'keep.png' },
        { label: 'Manifest proof', file: 'screenshots/manifest-proof.png' },
      ],
      omit: ['redundant.png'],
    }),
  );
  await execLocal(
    'git init && git config user.email test@example.com && git config user.name Test && git add . && git commit -m initial',
    {
      cwd: workerRepo,
    },
  );
  const headSha = (await execLocal('git rev-parse HEAD', { cwd: workerRepo })).stdout.trim();
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
        slots: [
          {
            id: slotId,
            enabled: true,
            repo: workerRepo,
            session: slotId,
          },
        ],
      },
      null,
      2,
    ),
  );

  const reviewDepth = {
    minimumIndependentReviews: 1,
    requireCrossRunner: false,
    extraLoopsRequested: 0,
    requestedBy: 'dispatch' as const,
  };
  const oldReviewSubjectHash = 'old-review-subject';
  const oldPackage = makeReadyGatePackage({
    headSha,
    evidenceManifest: [
      { path: 'artifacts/keep.png', purpose: 'debug-screenshot', sizeBytes: 7 },
      { path: 'artifacts/old.png', purpose: 'debug-screenshot', sizeBytes: 8 },
    ],
    selectedEvidenceKeys: ['artifacts/keep.png', 'artifacts/old.png'],
    reviewDepth,
    reviewSubjectHash: oldReviewSubjectHash,
  });
  const decision: RunDecision = {
    id: 'ready-decision-1',
    type: 'engine_human_gate',
    title: 'Ready',
    description: 'Ready',
    actions: [{ id: 'approve-publish', label: 'Approve Publish', style: 'primary' }],
    createdAt: '2026-05-17T00:00:00.000Z',
    payload: {
      kind: 'ready',
      prPackage: oldPackage,
      reviewDepth,
      publicationTarget: 'ready',
      publicationStatus: 'not_published',
    } as ReadyGatePayload,
  };
  const run = createRun({
    flowType: 'dev',
    mode: 'autonomous',
    project: 'farmslot-farm',
    ticketOrPr: 'PROJ-REFRESH',
    runner: 'codex',
  });
  updateRun(run.id, {
    slotId,
    taskFile,
    branch: 'main',
    steps: [
      {
        name: 'self-review',
        status: 'done',
        startedAt: '2026-05-17T00:10:00.000Z',
        completedAt: '2026-05-17T00:12:00.000Z',
        outputs: {
          verdict: 'pass',
          unresolvedCount: 0,
          reviewSnapshot: {
            headSha,
            capturedAt: '2026-05-17T00:12:00.000Z',
            source: 'local-git',
          },
        },
      },
    ],
    decisions: [decision],
    engineState: {
      publishGate: {
        reviewDepth,
        publicationTarget: 'ready',
        publicationStatus: 'not_published',
        independentReviews: [
          {
            id: 'self-review-2',
            source: 'self-review',
            crossRunner: false,
            loopNumber: 2,
            verdict: 'pass',
            unresolvedCount: 0,
            reviewSnapshot: {
              headSha,
              capturedAt: '2026-05-17T00:12:00.000Z',
              source: 'local-git',
            },
            reviewedHeadSha: headSha,
            reviewedReviewSubjectHash: oldReviewSubjectHash,
          },
        ],
      },
    },
  });

  const first = await refreshPublishPackage({
    runId: run.id,
    decisionId: decision.id,
    selectedEvidenceKeys: ['artifacts/keep.png', 'artifacts/old.png'],
    publicationTarget: 'draft',
  });

  assert.deepEqual(first.preservedEvidenceKeys, ['artifacts/keep.png']);
  assert.deepEqual(first.droppedEvidenceKeys, ['artifacts/old.png']);
  assert.equal(first.addedEvidenceKeys.includes('artifacts/screenshots/manifest-proof.png'), true);
  assert.equal(first.addedEvidenceKeys.includes('artifacts/after-new.png'), false);
  assert.equal(
    first.droppedEvidence[0]?.reason,
    'missing from refreshed package evidence manifest',
  );
  const refreshedDecision = getRun(run.id)!.decisions[0];
  const refreshedPayload = refreshedDecision.payload as ReadyGatePayload;
  assert.equal(refreshedPayload.publicationTarget, 'draft');
  assert.equal(
    refreshedPayload.prPackage?.selectedEvidenceKeys?.includes('artifacts/keep.png'),
    true,
    'preserved evidence should be selected',
  );
  assert.equal(
    refreshedPayload.prPackage?.selectedEvidenceKeys?.includes('artifacts/after-new.png'),
    false,
    'unreferenced screenshots should not be auto-selected when evidence-manifest is present',
  );
  assert.equal(
    refreshedPayload.prPackage?.selectedEvidenceKeys?.includes(
      'artifacts/screenshots/manifest-proof.png',
    ),
    true,
    'manifest-referenced screenshot evidence should be auto-selected',
  );
  assert.equal(refreshedPayload.prPackage?.publicationTarget, 'draft');
  assert.equal(
    refreshedDecision.actions.some((action) => action.id === 'approve-publish'),
    false,
  );
  assert.equal(
    getRun(run.id)!.engineState?.publishGate?.independentReviews?.[0]?.reviewedReviewSubjectHash,
    oldReviewSubjectHash,
  );
  assert.equal(refreshedDecision.resolvedAt, undefined);

  const packageText = await readFile(path.join(taskDir, 'artifacts/pr-package.json'), 'utf-8');
  const packageJson = JSON.parse(packageText) as ReadyGatePrPackage;
  assert.equal(packageJson.id, first.packageId);
  assert.ok(packageJson.evidenceManifest);
  assert.equal(
    packageJson.evidenceManifest.some((artifact) => artifact.sha256),
    true,
  );
  assert.equal(
    packageJson.evidenceManifest.some((artifact) => artifact.path === 'artifacts/pr-package.json'),
    false,
  );
  assert.equal(
    packageJson.evidenceManifest.some((artifact) => artifact.path === 'artifacts/redundant.png'),
    false,
  );
  assert.equal(
    packageJson.evidenceManifest.some(
      (artifact) =>
        artifact.path === 'artifacts/screenshots/manifest-proof.png' &&
        artifact.purpose === 'screenshot',
    ),
    true,
  );
  assert.equal(packageJson.draftBody.includes('artifacts/screenshots/manifest-proof.png'), true);
  assert.equal(
    existsSync(path.join(taskDir, 'artifacts/screenshots/manifest-proof.png')),
    true,
    'refresh should copy evidence-manifest referenced screenshots out of the raw spool',
  );
  assert.equal(
    packageJson.evidenceManifest.some((artifact) =>
      artifact.path.startsWith('artifacts/independent-review-2/'),
    ),
    false,
  );
  assert.equal(
    packageJson.evidenceManifest.some((artifact) =>
      artifact.path.startsWith('artifacts/review-loop-1/'),
    ),
    false,
  );

  const second = await refreshPublishPackage({
    runId: run.id,
    decisionId: decision.id,
    selectedEvidenceKeys: refreshedPayload.prPackage!.selectedEvidenceKeys!,
    publicationTarget: 'draft',
  });
  assert.equal(second.packageInputHash, first.packageInputHash);
  assert.equal(second.reviewSubjectHash, first.reviewSubjectHash);
  assert.deepEqual(second.droppedEvidenceKeys, []);
  assert.equal(
    getRun(run.id)!.engineState?.publishGate?.independentReviews?.[0]?.reviewedReviewSubjectHash,
    oldReviewSubjectHash,
  );

  updateRun(run.id, { slotId: null });
  const releasedPayload = getRun(run.id)!.decisions[0].payload as ReadyGatePayload;
  const released = await refreshPublishPackage({
    runId: run.id,
    decisionId: decision.id,
    selectedEvidenceKeys: releasedPayload.prPackage!.selectedEvidenceKeys!,
    publicationTarget: 'draft',
  });
  assert.equal(released.packageHeadSha, headSha);
  assert.deepEqual(released.droppedEvidenceKeys, []);
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
  await mkdir(path.join(taskDir, 'artifacts/independent-review-1/review-loop-1'), {
    recursive: true,
  });
  const workerTaskDir = path.join(workerRepo, '.sandbox/farmslot-farm/worker-task', taskRelDir);
  await mkdir(path.join(workerTaskDir, 'artifacts'), { recursive: true });
  await writeFile(taskFile, '# refresh package fail test\n');
  const preservedReviewDiff = path.join(
    taskDir,
    'artifacts/independent-review-1/review-loop-1/review.diff',
  );
  await writeFile(preservedReviewDiff, 'preserved review diff\n');
  await writeFile(path.join(workerRepo, 'README.md'), 'worker repo\n');
  await execLocal(
    'git init && git config user.email test@example.com && git config user.name Test && git add . && git commit -m initial',
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
    engineState: { publishGate: { publicationStatus: 'not_published', independentReviews: [] } },
  });

  await assert.rejects(
    () =>
      refreshPublishPackage({
        runId: run.id,
        decisionId: decision.id,
        selectedEvidenceKeys: [],
        publicationTarget: 'ready',
      }),
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
