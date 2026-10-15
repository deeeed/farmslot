// @farmslot:serial — creates and removes real JSON under the shared repo `pool/`.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type {
  ReadyGatePayload,
  ReadyGatePrPackage,
  ReviewStatus,
  RunDecision,
} from '@farmslot/protocol';

import { execLocal } from '../core/exec.js';
import { farmslotRoot } from '../fleet/state.js';
import { runResolveDecision } from '../methods/run.js';
import { capturePublicationSource } from '../run-completion/publication-source.js';
import { createRun, getRun, updateRun, updateRunStep } from '../runs/store.js';

import { findLatestResolvedDecision } from './decision-replay.js';
import { APPROVE_PUBLISH_SNAPSHOT_UNAVAILABLE_ACTION } from './gate-policy.js';
import { refreshPublishPackage } from './publish-package-refresh.js';
import { deleteTestRunIfPresent, makeReadyGatePackage } from './test-fixtures.js';

// Manual release proof. Local git and full artifact preparation exceed the unit-test budget.
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
  await mkdir(path.join(taskDir, 'artifacts/review-2/review-loop-1'), {
    recursive: true,
  });
  await mkdir(path.join(taskDir, 'artifacts/review-loop-1'), { recursive: true });
  await writeFile(path.join(taskDir, 'TASK.md'), '# refresh package test\n');
  await writeFile(
    path.join(taskDir, 'artifacts/review-2/review-loop-1/review.diff'),
    'review diff\n',
  );
  await writeFile(path.join(taskDir, 'artifacts/review-loop-1/review.md'), 'self review\n');
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
    'git init -b main && git config user.email test@example.com && git config user.name Test && git add . && git commit -m initial',
    {
      cwd: workerRepo,
    },
  );
  let headSha = (await execLocal('git rev-parse HEAD', { cwd: workerRepo })).stdout.trim();
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

  const reviewPolicy = {
    minimumReviews: 1,
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
    reviewPolicy,
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
      reviewPolicy,
      publicationTarget: 'ready',
      publicationStatus: 'not_published',
      // Stale soft-chip fields from a prior probe — refresh must replace, not partial-spread.
      behindMain: 21,
      mergeConflicts: true,
      mergeConflictPaths: ['f.ts'],
      branchFreshnessHint: 'behindMain: 21, mergeConflicts: true. Next: git merge origin/main',
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
        name: 'review',
        status: 'done',
        startedAt: '2026-05-17T00:10:00.000Z',
        completedAt: '2026-05-17T00:12:00.000Z',
        outputs: {
          reviewId: 'pipeline-review-2',
          mode: 'cold',
          verdict: 'pass',
          unresolvedCount: 0,
          reviewSnapshot: {
            headSha: 'stale-pipeline-head',
            capturedAt: '2026-05-17T00:12:00.000Z',
            source: 'local-git',
          },
        },
      },
    ],
    decisions: [decision],
    engineState: {
      publishGate: {
        reviewPolicy,
        publicationTarget: 'ready',
        publicationStatus: 'not_published',
        reviews: [
          {
            reviewerSessionId: 'fixture-session-' + 'review-2',
            mode: 'warm' as const,
            id: 'pipeline-review-2',
            source: 'pipeline',
            loopNumber: 2,
            verdict: 'pass',
            unresolvedCount: 0,
            completedAt: '2026-05-17T00:14:00.000Z',
            session: {
              mode: 'warm',
              continuity: 'resumed',
              reviewId: 'pipeline-review-2',
              sessionId: 'fixture-session-review-2',
              lastReviewedHeadSha: 'stale-pipeline-head',
            },
            attempts: [
              { mode: 'cold', loopNumber: 1, verdict: 'pass', unresolvedCount: 0 },
              { mode: 'warm', loopNumber: 2, verdict: 'pass', unresolvedCount: 0 },
            ],
            reviewSnapshot: {
              baseSha: 'stale-pipeline-head',
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

  await writeFile(path.join(taskDir, 'artifacts/pr-package.json'), JSON.stringify(oldPackage));
  const previousGate = structuredClone(getRun(run.id)!.decisions);
  const previousState = structuredClone(getRun(run.id)!.engineState?.publishGate);
  const previousIndex = await readFile(path.join(taskDir, 'artifacts/pr-package.json'), 'utf8');
  let sourceReads = 0;
  await assert.rejects(
    refreshPublishPackage(
      { runId: run.id, decisionId: decision.id },
      {
        progress: async () => ({ kind: 'idle' }),
        source: async (current) => {
          const source = await capturePublicationSource(current, {
            slot: async () => ({ current_run_id: current.id, slot_epoch: 1 }),
          });
          return ++sourceReads > 1 ? { ...source, headSha: 'b'.repeat(40) } : source;
        },
      },
    ),
    /ownership or HEAD changed/,
  );
  assert.deepEqual(getRun(run.id)!.decisions, previousGate);
  assert.deepEqual(getRun(run.id)!.engineState?.publishGate, previousState);
  assert.equal(
    await readFile(path.join(taskDir, 'artifacts/pr-package.json'), 'utf8'),
    previousIndex,
  );

  const first = await refreshPublishPackage(
    {
      runId: run.id,
      decisionId: decision.id,
      selectedEvidenceKeys: ['artifacts/keep.png', 'artifacts/old.png'],
      publicationTarget: 'draft',
    },
    {
      progress: async () => ({ kind: 'idle' }),
      source: (current) =>
        capturePublicationSource(current, {
          slot: async () => ({ current_run_id: current.id, slot_epoch: 1 }),
        }),
    },
  );

  assert.deepEqual(first.preservedEvidenceKeys, ['artifacts/keep.png']);
  assert.deepEqual(first.droppedEvidenceKeys, ['artifacts/old.png']);
  assert.equal(first.addedEvidenceKeys.includes('artifacts/screenshots/manifest-proof.png'), true);
  assert.equal(first.addedEvidenceKeys.includes('artifacts/after-new.png'), false);
  assert.equal(
    first.droppedEvidence[0]?.reason,
    'missing from refreshed package evidence manifest',
  );
  const refreshedDecision = getRun(run.id)!.decisions.find((entry) => entry.id === decision.id)!;
  const refreshedPayload = refreshedDecision.payload as ReadyGatePayload;
  assert.equal(
    getRun(run.id)!.decisions.at(-1)?.id,
    decision.id,
    'package history must precede the live decision for every array-order reader',
  );
  const requested: RunDecision = {
    ...refreshedDecision,
    resolvedAt: '2026-05-17T00:16:00.000Z',
    resolvedAction: 'request-review',
  };
  const requestedDecisions = getRun(run.id)!.decisions.map((entry) =>
    entry.id === decision.id ? requested : entry,
  );
  assert.equal(findLatestResolvedDecision(requestedDecisions, 'human_gate'), requested);
  assert.equal(
    [...requestedDecisions]
      .reverse()
      .find((entry) => entry.type === 'engine_human_gate' && entry.payload?.kind === 'ready'),
    requested,
  );
  assert.equal(refreshedPayload.publicationTarget, 'draft');
  const refreshedReview = getRun(run.id)!.engineState!.publishGate!.reviews![0]!;
  assert.equal(getRun(run.id)!.engineState!.publishGate!.reviews!.length, 1);
  assert.equal(refreshedReview.mode, 'warm');
  assert.equal(refreshedReview.reviewSnapshot?.headSha, headSha);
  assert.equal(refreshedReview.session?.lastReviewedHeadSha, 'stale-pipeline-head');
  assert.equal(refreshedReview.attempts?.length, 2);
  assert.equal(refreshedPayload.gateSummary?.review.passingReviews, 0);
  // Wiring: soft fields are re-probed on the live slot repo (clean main) and must
  // not keep stale mergeConflictPaths / hints from the prior payload.
  assert.notEqual(refreshedPayload.mergeConflicts, true);
  assert.ok(
    !refreshedPayload.mergeConflictPaths?.includes('f.ts'),
    'stale conflict path sample must not survive package refresh',
  );
  assert.ok(
    !refreshedPayload.branchFreshnessHint?.includes('behindMain: 21'),
    'stale branchFreshnessHint must not survive package refresh',
  );
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
    getRun(run.id)!.engineState?.publishGate?.reviews?.[0]?.reviewedReviewSubjectHash,
    oldReviewSubjectHash,
  );
  assert.equal(refreshedDecision.resolvedAt, undefined);

  const packageText = await readFile(path.join(taskDir, 'artifacts/pr-package.json'), 'utf-8');
  const packageJson = JSON.parse(packageText) as ReadyGatePrPackage;
  assert.equal(packageJson.id, first.packageId);
  const immutableMarkdown = path.join(taskDir, packageJson.artifactPath.replace(/\.json$/, '.md'));
  assert.equal(
    await readFile(immutableMarkdown, 'utf8'),
    await readFile(path.join(taskDir, 'artifacts/pr-package.md'), 'utf8'),
  );
  assert.match(await readFile(immutableMarkdown, 'utf8'), new RegExp(first.packageId));
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
      artifact.path.startsWith('artifacts/review-2/'),
    ),
    false,
  );
  assert.equal(
    packageJson.evidenceManifest.some((artifact) =>
      artifact.path.startsWith('artifacts/review-loop-1/'),
    ),
    false,
  );

  const second = await refreshPublishPackage(
    {
      runId: run.id,
      decisionId: decision.id,
      selectedEvidenceKeys: refreshedPayload.prPackage!.selectedEvidenceKeys!,
      publicationTarget: 'draft',
    },
    {
      progress: async () => ({ kind: 'idle' }),
      source: (current) =>
        capturePublicationSource(current, {
          slot: async () => ({ current_run_id: current.id, slot_epoch: 1 }),
        }),
    },
  );
  assert.equal(second.packageInputHash, first.packageInputHash);
  assert.equal(second.reviewSubjectHash, first.reviewSubjectHash);
  assert.deepEqual(second.droppedEvidenceKeys, []);
  assert.equal(
    getRun(run.id)!.engineState?.publishGate?.reviews?.[0]?.reviewedReviewSubjectHash,
    oldReviewSubjectHash,
  );

  const priorHead = headSha;
  await writeFile(path.join(workerRepo, 'review-fix.txt'), 'later reviewed source\n');
  await execLocal('git add review-fix.txt', { cwd: workerRepo });
  await execLocal('git commit -m "fix: later reviewed source"', { cwd: workerRepo });
  headSha = (await execLocal('git rev-parse HEAD', { cwd: workerRepo })).stdout.trim();
  assert.notEqual(headSha, priorHead);
  updateRunStep(run.id, 'review', {
    status: 'done',
    outputs: {
      reviewId: 'pipeline-review-recovered',
      mode: 'cold',
      attempts: [
        {
          mode: 'cold',
          loopNumber: 1,
          verdict: 'pass',
          unresolvedCount: 0,
          completedAt: '2026-05-17T00:20:00.000Z',
          reviewSnapshot: { source: 'local-git', headSha, capturedAt: '2026-05-17T00:20:00.000Z' },
        },
      ],
    },
  });
  const recovered = await refreshPublishPackage(
    { runId: run.id, decisionId: decision.id },
    {
      progress: async () => ({ kind: 'idle' }),
      source: (current) =>
        capturePublicationSource(current, {
          slot: async () => ({ current_run_id: current.id, slot_epoch: 1 }),
        }),
    },
  );
  const recoveredReviews = getRun(run.id)!.engineState!.publishGate!.reviews!;
  const materialized = recoveredReviews.find((review) => review.id === 'pipeline-review-recovered');
  assert.ok(materialized, 'deferred commit must retain newly materialized reviews');
  assert.equal(materialized.verdict, 'pass');
  assert.equal(materialized.attempts?.length, 1);
  assert.equal(materialized.reviewSnapshot?.headSha, headSha);
  assert.equal(recovered.packageHeadSha, headSha);
  const recoveredPackage = (
    getRun(run.id)!.decisions.find((entry) => entry.id === decision.id)!.payload as ReadyGatePayload
  ).prPackage!;
  assert.deepEqual(
    [...recoveredPackage.reviewArtifactIds].sort(),
    recoveredReviews.flatMap((review) => review.artifactPaths ?? [review.id]).sort(),
  );

  await rm(poolFile, { force: true });
  // Re-seed stale fields after the configured slot is removed while the
  // durable run still retains its slot id.
  const beforeRelease = getRun(run.id)!;
  const beforeReleaseDecision = beforeRelease.decisions.find((entry) => entry.id === decision.id)!;
  updateRun(run.id, {
    decisions: beforeRelease.decisions.map((entry) =>
      entry.id === beforeReleaseDecision.id
        ? {
            ...entry,
            payload: {
              ...(entry.payload as ReadyGatePayload),
              behindMain: 99,
              mergeConflicts: true,
              mergeConflictPaths: ['stale.ts'],
              branchFreshnessHint: 'stale hint',
            },
          }
        : entry,
    ),
  });
  const releasedPayload = getRun(run.id)!.decisions.find((entry) => entry.id === decision.id)!
    .payload as ReadyGatePayload;
  const released = await refreshPublishPackage({
    runId: run.id,
    decisionId: decision.id,
    selectedEvidenceKeys: releasedPayload.prPackage!.selectedEvidenceKeys!,
    publicationTarget: 'draft',
  });
  assert.equal(released.packageHeadSha, headSha);
  assert.deepEqual(released.droppedEvidenceKeys, []);
  const afterRelease = getRun(run.id)!.decisions.find((entry) => entry.id === decision.id)!
    .payload as ReadyGatePayload;
  assert.equal(afterRelease.behindMain, undefined);
  assert.equal(afterRelease.mergeConflicts, undefined);
  assert.equal(afterRelease.mergeConflictPaths, undefined);
  assert.equal(afterRelease.branchFreshnessHint, undefined);
  assert.equal(afterRelease.prPackage?.reviewSnapshot?.source, 'unavailable');
  assert.equal(afterRelease.prPackage?.reviewSnapshot?.missingReason, 'slot-load-error');

  const unavailablePackage = afterRelease.prPackage!;
  const exactReview: ReviewStatus = {
    reviewerSessionId: 'fixture-session-' + 'review-removed-slot',
    mode: 'cold' as const,
    id: 'review-removed-slot',
    source: 'dispatch',
    loopNumber: 1,
    verdict: 'pass',
    unresolvedCount: 0,
    reviewedHeadSha: unavailablePackage.headSha,
    reviewedReviewSubjectHash: unavailablePackage.reviewSubjectHash,
    reviewSnapshot: unavailablePackage.reviewSnapshot,
  };
  const beforeApproval = getRun(run.id)!;
  updateRun(run.id, {
    status: 'monitoring',
    engineState: {
      ...beforeApproval.engineState,
      publishGate: {
        ...beforeApproval.engineState?.publishGate,
        reviewPolicy,
        reviews: [exactReview],
      },
    },
    decisions: beforeApproval.decisions.map((entry) =>
      entry.id === decision.id
        ? {
            ...entry,
            context: undefined,
            actions: [
              ...entry.actions,
              {
                id: APPROVE_PUBLISH_SNAPSHOT_UNAVAILABLE_ACTION,
                label: 'Publish Anyway (snapshot unavailable)',
                style: 'primary' as const,
              },
            ],
          }
        : entry,
    ),
  });
  await runResolveDecision(
    {
      runId: run.id,
      decisionId: decision.id,
      actionId: APPROVE_PUBLISH_SNAPSHOT_UNAVAILABLE_ACTION,
      selectionData: {
        packageId: unavailablePackage.id,
        packageHash: unavailablePackage.packageHash,
        packageHeadSha: unavailablePackage.headSha,
        selectedEvidenceKeys: unavailablePackage.selectedEvidenceKeys,
      },
    },
    () => {},
    { assertGatePrerequisites: async () => {} },
  );
  assert.equal(
    getRun(run.id)!.decisions.find((entry) => entry.id === decision.id)?.resolvedAction,
    APPROVE_PUBLISH_SNAPSHOT_UNAVAILABLE_ACTION,
  );
});
