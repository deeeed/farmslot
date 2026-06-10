import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  DEFAULT_CURSOR_MODEL,
  type ReadyGatePrPackage,
  type RunDecision,
} from '@farmslot/protocol';

import { invalidateProjectVarsCache, projectsDir } from '../core/config.js';
import { computeReadyGatePackageHash } from '../run-completion/ready-gate-package.js';
import { createRun, deleteRun, getRun, updateRun } from '../runs/store.js';

import { makeRun } from './run/test-fixtures.js';
import {
  assertDuplicateRunAllowed,
  resolveCreateSafetyTier,
  runCreate,
  runInteractiveDevResolve,
  runRehydratePrNumber,
  runResolveDecision,
} from './run.js';

function makeReadyGatePackage(overrides: Partial<ReadyGatePrPackage> = {}): ReadyGatePrPackage {
  const packageWithoutHash: Omit<ReadyGatePrPackage, 'packageHash'> = {
    id: overrides.id ?? 'pkg-test',
    artifactPath: overrides.artifactPath ?? 'artifacts/pr-package.json',
    branch: overrides.branch ?? 'feature/test',
    remoteBranchRef: overrides.remoteBranchRef ?? 'origin/feature/test',
    headSha: overrides.headSha ?? 'abc1234',
    diffStat: overrides.diffStat ?? { files: 1, additions: 2, deletions: 0 },
    draftTitle: overrides.draftTitle ?? 'fix(test): publish package',
    draftBody: overrides.draftBody ?? 'body',
    evidenceManifest: overrides.evidenceManifest ?? [],
    selectedEvidenceKeys: overrides.selectedEvidenceKeys ?? [],
    validationSummaryPath: overrides.validationSummaryPath ?? null,
    validationSummaryHash: overrides.validationSummaryHash ?? null,
    reviewArtifactIds: overrides.reviewArtifactIds ?? [],
    dispatchMode: overrides.dispatchMode ?? 'autonomous',
    gatePolicy: overrides.gatePolicy ?? {
      owner: 'human',
      dispatchMode: 'autonomous',
      publishAuthority: 'human',
      reason: 'local-first publication requires human approval',
    },
    reviewDepth: overrides.reviewDepth ?? {
      minimumIndependentReviews: 0,
      requireCrossRunner: false,
      extraLoopsRequested: 0,
      requestedBy: 'dispatch',
    },
    publicationTarget: overrides.publicationTarget ?? 'ready',
    publicationStatus: overrides.publicationStatus ?? 'not_published',
    createdAt: overrides.createdAt ?? '2026-04-15T00:00:00.000Z',
  };
  const packageHash = overrides.packageHash ?? computeReadyGatePackageHash(packageWithoutHash);
  return { ...packageWithoutHash, packageHash };
}

function sha256Text(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

test('runResolveDecision keeps publish gate pending when approved package selection is stale', async (t) => {
  const run = createRun({
    flowType: 'fix-bug',
    project: 'farmslot-farm',
    ticketOrPr: `PUBLISH-STALE-${Date.now().toString(16).toUpperCase()}`,
    mode: 'autonomous',
    initialContext: 'Exercise stale publish package approval',
  });
  t.after(async () => {
    if (getRun(run.id)) {
      updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
      await deleteRun(run.id);
    }
  });

  const prPackage = makeReadyGatePackage();
  const decision: RunDecision = {
    id: 'publish-gate',
    type: 'engine_human_gate',
    title: 'Ready',
    description: 'Ready',
    actions: [{ id: 'approve-publish', label: 'Approve Publish', style: 'primary' as const }],
    createdAt: '2026-04-15T00:00:00.000Z',
    payload: {
      kind: 'ready',
      prNumber: null,
      repo: null,
      diffStat: prPackage.diffStat,
      workerReport: 'ready',
      branch: prPackage.branch,
      headSha: prPackage.headSha,
      artifactManifest: prPackage.evidenceManifest,
      prPackage,
      publicationTarget: 'ready',
      publicationStatus: 'not_published',
      reviewDepth: prPackage.reviewDepth,
      independentReviews: [],
    },
  };
  updateRun(run.id, {
    decisions: [decision],
    engineState: {
      publishGate: {
        publicationStatus: 'not_published',
        reviewDepth: prPackage.reviewDepth,
        independentReviews: [],
      },
    },
  });

  await assert.rejects(
    () =>
      runResolveDecision(
        {
          runId: run.id,
          decisionId: decision.id,
          actionId: 'approve-publish',
          selectionData: {
            packageId: prPackage.id,
            packageHash: 'stale-hash',
            packageHeadSha: prPackage.headSha,
          },
        },
        () => {},
      ),
    /refresh package and re-review before publishing/,
  );
  const stillPending = getRun(run.id)?.decisions.find((entry) => entry.id === decision.id);
  assert.equal(stillPending?.resolvedAt, undefined);
});

test('runResolveDecision rejects approval when current package artifact drifted', async (t) => {
  const taskDir = mkdtempSync(path.join(tmpdir(), 'farmslot-package-drift-'));
  t.after(() => rmSync(taskDir, { recursive: true, force: true }));
  mkdirSync(path.join(taskDir, 'artifacts'), { recursive: true });
  const taskFile = path.join(taskDir, 'task.md');
  writeFileSync(taskFile, 'task', 'utf-8');

  const run = createRun({
    flowType: 'fix-bug',
    project: 'farmslot-farm',
    ticketOrPr: `PUBLISH-DRIFT-${Date.now().toString(16).toUpperCase()}`,
    mode: 'autonomous',
    initialContext: 'Exercise current package drift approval',
  });
  t.after(async () => {
    if (getRun(run.id)) {
      updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
      await deleteRun(run.id);
    }
  });

  const visiblePackage = makeReadyGatePackage({ id: 'pkg-visible' });
  const currentPackage = makeReadyGatePackage({ id: 'pkg-current' });
  writeFileSync(
    path.join(taskDir, currentPackage.artifactPath),
    JSON.stringify(currentPackage, null, 2),
    'utf-8',
  );
  const decision: RunDecision = {
    id: 'publish-gate-drift',
    type: 'engine_human_gate',
    title: 'Ready',
    description: 'Ready',
    actions: [{ id: 'approve-publish', label: 'Approve Publish', style: 'primary' as const }],
    createdAt: '2026-04-15T00:00:00.000Z',
    payload: {
      kind: 'ready',
      prNumber: null,
      repo: null,
      diffStat: visiblePackage.diffStat,
      workerReport: 'ready',
      branch: visiblePackage.branch,
      headSha: visiblePackage.headSha,
      artifactManifest: visiblePackage.evidenceManifest,
      prPackage: visiblePackage,
      publicationTarget: 'ready',
      publicationStatus: 'not_published',
      reviewDepth: visiblePackage.reviewDepth,
      independentReviews: [],
    },
  };
  updateRun(run.id, {
    taskFile,
    decisions: [decision],
    engineState: {
      publishGate: {
        packageArtifactPath: currentPackage.artifactPath,
        publicationStatus: 'not_published',
        reviewDepth: visiblePackage.reviewDepth,
        independentReviews: [],
      },
    },
  });

  await assert.rejects(
    () =>
      runResolveDecision(
        {
          runId: run.id,
          decisionId: decision.id,
          actionId: 'approve-publish',
          selectionData: {
            packageId: visiblePackage.id,
            packageHash: visiblePackage.packageHash,
            packageHeadSha: visiblePackage.headSha,
          },
        },
        () => {},
      ),
    /refresh package and re-review before publishing/,
  );
  const stillPending = getRun(run.id)?.decisions.find((entry) => entry.id === decision.id);
  assert.equal(stillPending?.resolvedAt, undefined);
});

test('runResolveDecision rejects approval when selected evidence hash drifted', async (t) => {
  const taskDir = mkdtempSync(path.join(tmpdir(), 'farmslot-evidence-drift-'));
  t.after(() => rmSync(taskDir, { recursive: true, force: true }));
  mkdirSync(path.join(taskDir, 'artifacts'), { recursive: true });
  const taskFile = path.join(taskDir, 'task.md');
  const evidencePath = path.join(taskDir, 'artifacts/keep.png');
  writeFileSync(taskFile, 'task', 'utf-8');
  writeFileSync(evidencePath, 'original-image', 'utf-8');

  const prPackage = makeReadyGatePackage({
    evidenceManifest: [
      {
        path: 'artifacts/keep.png',
        purpose: 'after',
        sizeBytes: 'original-image'.length,
        sha256: sha256Text('original-image'),
      },
    ],
    selectedEvidenceKeys: ['artifacts/keep.png'],
  });
  writeFileSync(
    path.join(taskDir, prPackage.artifactPath),
    JSON.stringify(prPackage, null, 2),
    'utf-8',
  );
  writeFileSync(evidencePath, 'mutated-image', 'utf-8');

  const run = createRun({
    flowType: 'fix-bug',
    project: 'farmslot-farm',
    ticketOrPr: `EVIDENCE-DRIFT-${Date.now().toString(16).toUpperCase()}`,
    mode: 'autonomous',
    initialContext: 'Exercise selected evidence drift approval',
  });
  t.after(async () => {
    if (getRun(run.id)) {
      updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
      await deleteRun(run.id);
    }
  });

  const decision: RunDecision = {
    id: 'publish-gate-evidence-drift',
    type: 'engine_human_gate',
    title: 'Ready',
    description: 'Ready',
    actions: [{ id: 'approve-publish', label: 'Approve Publish', style: 'primary' as const }],
    createdAt: '2026-04-15T00:00:00.000Z',
    payload: {
      kind: 'ready',
      prNumber: null,
      repo: null,
      diffStat: prPackage.diffStat,
      workerReport: 'ready',
      branch: prPackage.branch,
      headSha: prPackage.headSha,
      artifactManifest: prPackage.evidenceManifest,
      prPackage,
      publicationTarget: 'ready',
      publicationStatus: 'not_published',
      reviewDepth: prPackage.reviewDepth,
      independentReviews: [],
    },
  };
  updateRun(run.id, {
    taskFile,
    decisions: [decision],
    engineState: {
      publishGate: {
        packageArtifactPath: prPackage.artifactPath,
        publicationStatus: 'not_published',
        reviewDepth: prPackage.reviewDepth,
        independentReviews: [],
      },
    },
  });

  await assert.rejects(
    () =>
      runResolveDecision(
        {
          runId: run.id,
          decisionId: decision.id,
          actionId: 'approve-publish',
          selectionData: {
            packageId: prPackage.id,
            packageHash: prPackage.packageHash,
            packageHeadSha: prPackage.headSha,
            selectedEvidenceKeys: ['artifacts/keep.png'],
          },
        },
        () => {},
      ),
    /selected evidence hash mismatch/,
  );
  const stillPending = getRun(run.id)?.decisions.find((entry) => entry.id === decision.id);
  assert.equal(stillPending?.resolvedAt, undefined);
});

test('runResolveDecision rejects approval when selected evidence differs from refreshed package', async (t) => {
  const taskDir = mkdtempSync(path.join(tmpdir(), 'farmslot-evidence-selection-'));
  t.after(() => rmSync(taskDir, { recursive: true, force: true }));
  mkdirSync(path.join(taskDir, 'artifacts'), { recursive: true });
  const taskFile = path.join(taskDir, 'task.md');
  writeFileSync(taskFile, 'task', 'utf-8');

  const prPackage = makeReadyGatePackage({
    evidenceManifest: [
      {
        path: 'artifacts/keep.png',
        purpose: 'after',
        sizeBytes: 10,
        sha256: sha256Text('original-image'),
      },
    ],
    selectedEvidenceKeys: ['artifacts/keep.png'],
  });
  writeFileSync(
    path.join(taskDir, prPackage.artifactPath),
    JSON.stringify(prPackage, null, 2),
    'utf-8',
  );

  const run = createRun({
    flowType: 'fix-bug',
    project: 'farmslot-farm',
    ticketOrPr: `EVIDENCE-SELECTION-${Date.now().toString(16).toUpperCase()}`,
    mode: 'autonomous',
    initialContext: 'Exercise selected evidence approval mismatch',
  });
  t.after(async () => {
    if (getRun(run.id)) {
      updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
      await deleteRun(run.id);
    }
  });

  const decision: RunDecision = {
    id: 'publish-gate-evidence-selection',
    type: 'engine_human_gate',
    title: 'Ready',
    description: 'Ready',
    actions: [{ id: 'approve-publish', label: 'Approve Publish', style: 'primary' as const }],
    createdAt: '2026-04-15T00:00:00.000Z',
    payload: {
      kind: 'ready',
      prNumber: null,
      repo: null,
      diffStat: prPackage.diffStat,
      workerReport: 'ready',
      branch: prPackage.branch,
      headSha: prPackage.headSha,
      artifactManifest: prPackage.evidenceManifest,
      prPackage,
      publicationTarget: 'ready',
      publicationStatus: 'not_published',
      reviewDepth: prPackage.reviewDepth,
      independentReviews: [],
    },
  };
  updateRun(run.id, {
    taskFile,
    decisions: [decision],
    engineState: {
      publishGate: {
        packageArtifactPath: prPackage.artifactPath,
        publicationStatus: 'not_published',
        reviewDepth: prPackage.reviewDepth,
        independentReviews: [],
      },
    },
  });

  await assert.rejects(
    () =>
      runResolveDecision(
        {
          runId: run.id,
          decisionId: decision.id,
          actionId: 'approve-publish',
          selectionData: {
            packageId: prPackage.id,
            packageHash: prPackage.packageHash,
            packageHeadSha: prPackage.headSha,
            selectedEvidenceKeys: [],
          },
        },
        () => {},
      ),
    /selected evidence differs/,
  );
  const stillPending = getRun(run.id)?.decisions.find((entry) => entry.id === decision.id);
  assert.equal(stillPending?.resolvedAt, undefined);
});

test('production duplicate runs are rejected', () => {
  assert.throws(
    () =>
      assertDuplicateRunAllowed(
        {
          ticketOrPr: 'PROJ-1',
          project: 'example-mobile-farm',
          flowType: 'fix-bug',
          lane: 'production',
          variant: null,
          familyId: 'family-2',
        },
        [makeRun()],
      ),
    /Active run already exists/,
  );
});

test('comparison duplicates require explicit family id', () => {
  assert.throws(
    () =>
      assertDuplicateRunAllowed(
        {
          ticketOrPr: 'PROJ-1',
          project: 'example-mobile-farm',
          flowType: 'dev',
          lane: 'comparison',
          variant: 'codex',
          familyId: undefined,
        },
        [makeRun({ lane: 'comparison', variant: 'claude' })],
      ),
    /require an explicit familyId/,
  );
});

test('comparison duplicates reject conflicting family or reused variant', () => {
  assert.throws(
    () =>
      assertDuplicateRunAllowed(
        {
          ticketOrPr: 'PROJ-1',
          project: 'example-mobile-farm',
          flowType: 'dev',
          lane: 'comparison',
          variant: 'claude',
          familyId: 'family-1',
        },
        [makeRun({ lane: 'comparison', variant: 'claude', familyId: 'family-1' })],
      ),
    /Comparison duplicate blocked/,
  );
});

test('comparison duplicates are allowed for same family with distinct variants', () => {
  assert.doesNotThrow(() =>
    assertDuplicateRunAllowed(
      {
        ticketOrPr: 'PROJ-1',
        project: 'example-mobile-farm',
        flowType: 'dev',
        lane: 'comparison',
        variant: 'codex',
        familyId: 'family-1',
      },
      [makeRun({ lane: 'comparison', variant: 'claude', familyId: 'family-1' })],
    ),
  );
});

test('createRun persists lightweight interactive dev initial context policy', async (t) => {
  const run = createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: `DEV-LOCAL-${Date.now().toString(16).toUpperCase()}`,
    mode: 'interactive',
    initialContext: 'Explore a faster local dev task launch flow',
  });
  t.after(async () => {
    if (getRun(run.id)) {
      updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
      await deleteRun(run.id);
    }
  });

  assert.equal(run.flowType, 'dev');
  assert.equal(run.devInteractiveProfile, 'lightweight');
  assert.equal(run.engineState?.interactiveDev?.profile, 'lightweight');
  assert.equal(
    run.engineState?.interactiveDev?.initialContext,
    'Explore a faster local dev task launch flow',
  );
});

test('createRun preserves reviewed interactive dev profile on dev lane', async (t) => {
  const run = createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: `DEV-REVIEWED-${Date.now().toString(16).toUpperCase()}`,
    mode: 'interactive',
    devInteractiveProfile: 'reviewed',
    initialContext: 'Prototype with self-review enabled',
  });
  t.after(async () => {
    if (getRun(run.id)) {
      updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
      await deleteRun(run.id);
    }
  });

  assert.equal(run.flowType, 'dev');
  assert.equal(run.devInteractiveProfile, 'reviewed');
  assert.equal(run.engineState?.interactiveDev?.profile, 'reviewed');
  assert.equal(
    run.engineState?.interactiveDev?.initialContext,
    'Prototype with self-review enabled',
  );
});

test('runInteractiveDevResolve rejects terminal interactive dev runs without slot mutation', async (t) => {
  const run = createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: `DEV-DONE-${Date.now().toString(16).toUpperCase()}`,
    mode: 'interactive',
    initialContext: 'Already complete interactive dev task',
  });
  updateRun(run.id, { status: 'done', completedAt: new Date().toISOString() });
  t.after(async () => {
    if (getRun(run.id)) {
      await deleteRun(run.id);
    }
  });

  const result = await runInteractiveDevResolve({ runId: run.id, action: 'done-no-pr' }, () => {});
  assert.equal(result.ok, false);
  assert.match(result.reason, /already terminal/);
  assert.equal(getRun(run.id)?.status, 'done');
});

test('runInteractiveDevResolve marks blocked and failed operator actions with audit state', async (t) => {
  const blocked = createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: `DEV-BLOCKED-${Date.now().toString(16).toUpperCase()}`,
    mode: 'interactive',
    initialContext: 'Blocked interactive dev task',
  });
  const failed = createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: `DEV-FAILED-${Date.now().toString(16).toUpperCase()}`,
    mode: 'interactive',
    initialContext: 'Failed interactive dev task',
    engineState: { generation: 2 },
  });
  updateRun(failed.id, {
    agentContexts: [
      {
        id: 'ctx-1',
        role: 'primary',
        label: 'Worker',
        status: 'working',
        slotId: 'slot-test',
        runId: failed.id,
        taskFile: 'TASK.md',
        runner: 'codex',
      },
    ],
  });
  t.after(async () => {
    for (const id of [blocked.id, failed.id]) {
      if (getRun(id)) {
        updateRun(id, { status: 'failed', completedAt: new Date().toISOString() });
        await deleteRun(id);
      }
    }
  });

  const blockedResult = await runInteractiveDevResolve(
    { runId: blocked.id, action: 'blocked', reason: 'waiting on API decision' },
    () => {},
  );
  assert.equal(blockedResult.ok, true);
  const blockedRun = getRun(blocked.id)!;
  assert.equal(blockedRun.status, 'blocked');
  assert.equal(blockedRun.metrics.outcome, 'partial');
  assert.equal(blockedRun.steps.find((step) => step.name === 'monitor')?.status, 'done');
  assert.equal(blockedRun.engineState?.interactiveDev?.terminalActions?.at(-1)?.action, 'blocked');

  const failedResult = await runInteractiveDevResolve(
    { runId: failed.id, action: 'failed', reason: 'operator stopped the attempt' },
    () => {},
  );
  assert.equal(failedResult.ok, true);
  const failedRun = getRun(failed.id)!;
  assert.equal(failedRun.status, 'failed');
  assert.equal(failedRun.metrics.outcome, 'failure');
  assert.deepEqual(failedRun.agentContexts, []);
  assert.equal(failedRun.engineState?.generation, 3);
  assert.equal(failedRun.engineState?.interactiveDev?.terminalActions?.at(-1)?.action, 'failed');
});

test('runInteractiveDevResolve links PR-complete handoff and closes parent ci-watch step', async (t) => {
  const previousNodeTestContext = process.env.NODE_TEST_CONTEXT;
  const previousDisableStart = process.env.FARMSLOT_DISABLE_RUN_ENGINE_START;
  process.env.NODE_TEST_CONTEXT = '1';
  process.env.FARMSLOT_DISABLE_RUN_ENGINE_START = '1';
  const projectDir = mkdtempSync(path.join(projectsDir, 'run-test-project-'));
  const project = path.basename(projectDir);
  writeFileSync(
    path.join(projectDir, 'project.json'),
    JSON.stringify({
      name: project,
      ci: { repo: 'example-org/example-mobile' },
    }),
    'utf-8',
  );
  const run = createRun({
    flowType: 'dev',
    project,
    ticketOrPr: `DEV-PRCOMPLETE-${Date.now().toString(16).toUpperCase()}`,
    mode: 'interactive',
    initialContext: 'Interactive dev task with PR-complete handoff',
    branch: 'feat/interactive-dev-handoff',
    runner: 'codex',
    model: 'gpt-5.5',
  });
  t.after(async () => {
    if (previousNodeTestContext === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = previousNodeTestContext;
    if (previousDisableStart === undefined) delete process.env.FARMSLOT_DISABLE_RUN_ENGINE_START;
    else process.env.FARMSLOT_DISABLE_RUN_ENGINE_START = previousDisableStart;
    invalidateProjectVarsCache(project);
    rmSync(projectDir, { recursive: true, force: true });
    const latest = getRun(run.id);
    if (latest) {
      updateRun(latest.id, { status: 'failed', completedAt: new Date().toISOString() });
      await deleteRun(latest.id);
    }
  });

  const result = await runInteractiveDevResolve(
    { runId: run.id, action: 'link-pr-and-pr-complete', prRef: '123456' },
    () => {},
  );
  assert.equal(result.ok, true);
  assert.equal(result.prNumber, 123456);
  assert.ok(result.chainedRunId);

  const parent = getRun(run.id)!;
  const child = getRun(result.chainedRunId!)!;
  t.after(async () => {
    if (getRun(child.id)) {
      updateRun(child.id, { status: 'failed', completedAt: new Date().toISOString() });
      await deleteRun(child.id);
    }
  });

  assert.equal(parent.status, 'done');
  assert.equal(parent.prNumber, 123456);
  assert.equal(parent.steps.find((step) => step.name === 'ci-watch')?.status, 'done');
  assert.equal(
    parent.steps.find((step) => step.name === 'complete')?.outputs?.handoff,
    'pr-complete',
  );
  assert.equal(parent.steps.find((step) => step.name === 'complete')?.outputs?.prNumber, 123456);
  assert.equal(
    parent.engineState?.interactiveDev?.terminalActions?.at(-1)?.action,
    'link-pr-and-pr-complete',
  );
  assert.equal(child.flowType, 'pr-complete');
  assert.equal(child.parentRunId, parent.id);
  assert.equal(child.ticketOrPr, 'example-org/example-mobile#123456');
});

test('comparison duplicates are blocked when existing active run is production lane', () => {
  assert.throws(
    () =>
      assertDuplicateRunAllowed(
        {
          ticketOrPr: 'PROJ-1',
          project: 'example-mobile-farm',
          flowType: 'dev',
          lane: 'comparison',
          variant: 'codex',
          familyId: 'family-1',
        },
        [makeRun({ lane: 'production', variant: null, familyId: 'family-1' })],
      ),
    /Comparison duplicate blocked/,
  );
});

test('active production run is not bypassed by direct startRef params', () => {
  assert.throws(
    () =>
      assertDuplicateRunAllowed(
        {
          ticketOrPr: 'PROJ-1',
          project: 'example-mobile-farm',
          flowType: 'dev',
          lane: 'comparison',
          variant: 'replay-codex',
          familyId: 'family-1',
          parentRunId: 'wrong-parent',
          completionPolicy: 'artifact-only',
          startRef: 'main',
        },
        [
          makeRun({
            id: 'baseline-run',
            lane: 'production',
            variant: null,
            familyId: 'family-1',
            status: 'monitoring',
          }),
        ],
      ),
    /Comparison duplicate blocked/,
  );
});

test('runCreate rejects direct prior-run startRef provenance', async (t) => {
  const previousDisableStart = process.env.FARMSLOT_DISABLE_RUN_ENGINE_START;
  process.env.FARMSLOT_DISABLE_RUN_ENGINE_START = '1';
  const baseline = createRun({
    flowType: 'fix-bug',
    project: 'example-mobile-farm',
    ticketOrPr: `PROJ-${Date.now()}`,
  });
  const created = [baseline.id];
  t.after(async () => {
    if (previousDisableStart === undefined) delete process.env.FARMSLOT_DISABLE_RUN_ENGINE_START;
    else process.env.FARMSLOT_DISABLE_RUN_ENGINE_START = previousDisableStart;
    for (const id of created.reverse()) {
      if (!getRun(id)) {
        continue;
      }
      updateRun(id, { status: 'done', completedAt: new Date().toISOString() });
      await deleteRun(id);
    }
  });

  await assert.rejects(
    () =>
      runCreate(
        {
          flowType: 'dev',
          project: baseline.project,
          ticketOrPr: baseline.ticketOrPr,
          familyId: baseline.familyId,
          parentRunId: baseline.id,
          lane: 'comparison',
          variant: 'replay-codex',
          completionPolicy: 'artifact-only',
          startRef: 'main',
          startRefSource: { kind: 'prior-run', runId: baseline.id },
        } as any,
        () => {},
      ),
    /eval\.experiment\.create \+ eval\.trial\.start|Comparison duplicate blocked/,
  );
});

test('runCreate persists implicit dev-interactive template selection for interactive dev', async (t) => {
  const previousNodeTestContext = process.env.NODE_TEST_CONTEXT;
  const previousDisableStart = process.env.FARMSLOT_DISABLE_RUN_ENGINE_START;
  process.env.NODE_TEST_CONTEXT = '1';
  process.env.FARMSLOT_DISABLE_RUN_ENGINE_START = '1';
  const created: string[] = [];
  t.after(async () => {
    if (previousNodeTestContext === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = previousNodeTestContext;
    if (previousDisableStart === undefined) delete process.env.FARMSLOT_DISABLE_RUN_ENGINE_START;
    else process.env.FARMSLOT_DISABLE_RUN_ENGINE_START = previousDisableStart;
    for (const id of created.reverse()) {
      const run = getRun(id);
      if (!run) continue;
      updateRun(id, { status: 'done', completedAt: new Date().toISOString() });
      await deleteRun(id);
    }
  });

  const result = await runCreate(
    {
      flowType: 'dev',
      mode: 'interactive',
      project: 'farmslot-farm',
      ticketOrPr: `interactive dev spike ${Date.now()}`,
    },
    () => {},
  );
  created.push(result.run.id);

  assert.deepEqual(result.run.taskTemplate, {
    fileName: 'dev-interactive.md',
    variant: 'interactive',
  });
});

test('runCreate persists implicit pr-complete-interactive template and branch-based lineage', async (t) => {
  const previousNodeTestContext = process.env.NODE_TEST_CONTEXT;
  const previousDisableStart = process.env.FARMSLOT_DISABLE_RUN_ENGINE_START;
  process.env.NODE_TEST_CONTEXT = '1';
  process.env.FARMSLOT_DISABLE_RUN_ENGINE_START = '1';
  const projectDir = mkdtempSync(path.join(projectsDir, 'run-test-pr-complete-'));
  const project = path.basename(projectDir);
  const templatesDir = path.join(projectDir, 'templates', 'worker');
  mkdirSync(templatesDir, { recursive: true });
  writeFileSync(
    path.join(projectDir, 'project.json'),
    JSON.stringify({ name: project, ci: { repo: 'example-org/example-mobile' } }),
    'utf-8',
  );
  writeFileSync(path.join(templatesDir, 'pr-complete.md'), 'Default PR complete\n', 'utf-8');
  writeFileSync(
    path.join(templatesDir, 'pr-complete-interactive.md'),
    'Interactive PR complete\n',
    'utf-8',
  );
  const created: string[] = [];
  const parent = createRun({
    flowType: 'dev',
    project,
    ticketOrPr: `TAT-${Date.now()}`,
    prNumber: 456789,
    branch: 'feat/pr-complete-reentry',
    taskFile: 'tasks/dev/TAT-root/TASK.md',
    familyRootTicketOrPr: 'TAT-root',
  });
  created.push(parent.id);
  t.after(async () => {
    if (previousNodeTestContext === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = previousNodeTestContext;
    if (previousDisableStart === undefined) delete process.env.FARMSLOT_DISABLE_RUN_ENGINE_START;
    else process.env.FARMSLOT_DISABLE_RUN_ENGINE_START = previousDisableStart;
    for (const id of created.reverse()) {
      const run = getRun(id);
      if (!run) continue;
      updateRun(id, { status: 'done', completedAt: new Date().toISOString() });
      await deleteRun(id);
    }
    invalidateProjectVarsCache(project);
    rmSync(projectDir, { recursive: true, force: true });
  });

  const result = await runCreate(
    {
      flowType: 'pr-complete',
      mode: 'interactive',
      project,
      ticketOrPr: 'example-org/example-mobile#456789',
    },
    () => {},
  );
  created.push(result.run.id);

  assert.deepEqual(result.run.taskTemplate, {
    fileName: 'pr-complete-interactive.md',
    variant: 'interactive',
  });
  assert.equal(result.run.branch, 'feat/pr-complete-reentry');
  assert.equal(result.run.parentRunId, parent.id);
  assert.equal(result.run.familyId, parent.familyId);
});

test('runResolveDecision rejects interactive PR-complete handoff resume without terminal signal', async (t) => {
  const run = createRun({
    flowType: 'pr-complete',
    project: 'example-mobile-farm',
    ticketOrPr: `example-org/example-mobile#${Date.now()}`,
    mode: 'interactive',
  });
  const decision: RunDecision = {
    id: 'interactive-handoff',
    type: 'monitor_interactive_handoff',
    title: 'Interactive handoff',
    description: 'Worker stopped for human handoff',
    actions: [
      { id: 'signal-written', label: 'I wrote SIGNAL.json', style: 'primary' },
      { id: 'abort', label: 'Abort Run', style: 'danger' },
    ],
    createdAt: new Date().toISOString(),
  };
  updateRun(run.id, { status: 'blocked', decisions: [decision] });
  t.after(async () => {
    if (getRun(run.id)) {
      updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
      await deleteRun(run.id);
    }
  });

  await assert.rejects(
    () =>
      runResolveDecision(
        {
          runId: run.id,
          decisionId: decision.id,
          actionId: 'signal-written',
        },
        () => {},
      ),
    /fresh terminal SIGNAL\.json/,
  );
  assert.equal(getRun(run.id)?.status, 'blocked');
  assert.equal(getRun(run.id)?.decisions[0]?.resolvedAt, undefined);
});

test('runRehydratePrNumber rejects unpublished autonomous dev runs before PR lookup', async (t) => {
  const run = createRun({
    flowType: 'dev',
    project: 'example-mobile-farm',
    ticketOrPr: `example-org/example-mobile#${Date.now()}`,
    mode: 'autonomous',
    lane: 'production',
  });
  t.after(async () => {
    updateRun(run.id, { status: 'done', completedAt: new Date().toISOString() });
    await deleteRun(run.id);
  });

  const result = await runRehydratePrNumber({ runId: run.id }, () => {});
  assert.deepEqual(result, {
    ok: false,
    reason:
      'publication status is not_published; human-approved publication is required before PR rehydrate',
  });
});

test('runRehydratePrNumber rejects artifact-only runs before any PR lookup', async (t) => {
  const run = createRun({
    flowType: 'dev',
    project: 'example-mobile-farm',
    ticketOrPr: `example-org/example-mobile#${Date.now()}`,
    mode: 'validation',
    lane: 'validation',
    completionPolicy: 'artifact-only',
  });
  t.after(async () => {
    updateRun(run.id, { status: 'done', completedAt: new Date().toISOString() });
    await deleteRun(run.id);
  });

  const result = await runRehydratePrNumber({ runId: run.id }, () => {});
  assert.deepEqual(result, {
    ok: false,
    reason: 'artifact-only runs never link or rehydrate PR numbers',
  });
});

// ─── resolveCreateSafetyTier ───

test('resolveCreateSafetyTier: explicit param wins over project default', () => {
  assert.equal(resolveCreateSafetyTier('sandboxed', 'dangerous'), 'sandboxed');
});

test('resolveCreateSafetyTier: project default applies when param is undefined', () => {
  assert.equal(resolveCreateSafetyTier(undefined, 'dangerous'), 'dangerous');
});

test('resolveCreateSafetyTier: undefined when neither is set (runner fallback applies later)', () => {
  assert.equal(resolveCreateSafetyTier(undefined, undefined), undefined);
});

test('createRun defaults explicit Cursor runner with missing model to composer-2.5', async (t) => {
  const run = createRun({
    flowType: 'fix-bug',
    project: 'example-mobile-farm',
    ticketOrPr: `PROJ-${Date.now()}-cursor-default`,
    runner: 'cursor',
  });
  t.after(async () => {
    updateRun(run.id, { status: 'done', completedAt: new Date().toISOString() });
    await deleteRun(run.id);
  });

  assert.equal(run.metrics.runner, 'cursor');
  assert.equal(run.metrics.model, DEFAULT_CURSOR_MODEL);
});

test('createRun treats explicit Cursor unknown model as unset', async (t) => {
  const run = createRun({
    flowType: 'fix-bug',
    project: 'example-mobile-farm',
    ticketOrPr: `PROJ-${Date.now()}-cursor-unknown`,
    runner: 'cursor',
    model: 'unknown',
  });
  t.after(async () => {
    updateRun(run.id, { status: 'done', completedAt: new Date().toISOString() });
    await deleteRun(run.id);
  });

  assert.equal(run.metrics.model, DEFAULT_CURSOR_MODEL);
});
