import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  DEFAULT_CURSOR_MODEL,
  type EvalExperimentManifest,
  type ResultPackageManifest,
} from '@farmslot/protocol';

import {
  computeCandidateStrategyFingerprint,
  computeExperimentKey,
  packageIdFor,
  unavailableDiff,
  writeEvalExperimentManifest,
  writeResultPackageManifest,
} from '../evals/package-store.js';
import { createRun, deleteRun, getRun, updateRun } from '../runs/store.js';
import { writeTaskFile } from '../tasks/writer.js';

import { harnessLifecycleForAxes } from './eval/candidate-setup.js';
import { candidateVariant, evalExperimentCreate, evalTrialStart } from './eval.js';

async function writeEvalTestFile(root: string, relPath: string, content: string): Promise<void> {
  const filePath = path.join(root, relPath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf-8');
}

function makeReferencePackage(): ResultPackageManifest {
  return {
    version: 1,
    kind: 'result-package',
    packageId: 'pkg-reference-source',
    packageHash: '',
    status: 'final',
    createdAt: '2026-05-09T00:00:00.000Z',
    finalizedAt: '2026-05-09T00:00:01.000Z',
    project: 'farmslot-farm',
    familyId: 'family-source',
    objectiveHash: 'objective-source',
    taskProfile: 'fix-bug',
    source: { kind: 'git-ref', ref: 'main', repository: 'owner/repo' },
    role: 'reference',
    diff: unavailableDiff('source-package-diff-missing'),
    axes: { template: { path: 'templates/fix-bug.md', hash: 'template-old' } },
    visualEvidence: [],
    validationEvidence: [],
    reviewEvidence: [],
    outcomeClaims: [],
    missingData: ['visual-evidence-missing'],
  };
}

test('evalExperimentCreate is idempotent for a package source', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'farmslot-eval-create-'));
  const evalRoots = new Set<string>();
  try {
    const packagePath = path.join(root, 'reference.result-package.json');
    const sourcePackage = await writeResultPackageManifest(packagePath, makeReferencePackage());
    const first = await evalExperimentCreate({
      project: 'farmslot-farm',
      taskProfile: 'fix-bug',
      source: { kind: 'package', packagePath },
    });
    evalRoots.add(path.dirname(path.dirname(first.experimentManifestPath)));
    const second = await evalExperimentCreate({
      project: 'farmslot-farm',
      taskProfile: 'fix-bug',
      source: { kind: 'package', packagePath },
    });
    const differentObjective = await evalExperimentCreate({
      project: 'farmslot-farm',
      taskProfile: 'fix-bug',
      source: { kind: 'package', packagePath },
      objective: 'Different objective',
    });
    evalRoots.add(path.dirname(path.dirname(differentObjective.experimentManifestPath)));

    assert.equal(first.experimentKey, second.experimentKey);
    assert.equal(first.experimentManifestPath, second.experimentManifestPath);
    assert.equal(first.referencePackage.packageHash, second.referencePackage.packageHash);
    assert.equal(
      first.referencePackage.packageId,
      packageIdFor({ experimentKey: first.experimentKey, role: 'reference' }),
    );
    assert.equal(
      differentObjective.referencePackage.packageId,
      packageIdFor({ experimentKey: differentObjective.experimentKey, role: 'reference' }),
    );
    assert.notEqual(first.referencePackage.packageId, sourcePackage.packageId);
    assert.notEqual(
      first.referencePackage.packageId,
      differentObjective.referencePackage.packageId,
    );
    assert.equal(first.referencePackage.source.kind, 'package');
    assert.equal(
      first.referencePackage.source.kind === 'package'
        ? first.referencePackage.source.packageHash
        : '',
      sourcePackage.packageHash,
    );
    assert.equal(
      first.experimentManifest.case.referencePackageId,
      first.referencePackage.packageId,
    );
    assert.equal(first.experimentManifest.candidateStrategies.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
    for (const evalRoot of evalRoots) {
      await rm(evalRoot, { recursive: true, force: true });
    }
  }
});

test('evalExperimentCreate persists dataset hooks and separates experiment keys by dataset item', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'farmslot-eval-dataset-hooks-'));
  const evalRoots = new Set<string>();
  try {
    const packagePath = path.join(root, 'reference.result-package.json');
    await writeResultPackageManifest(packagePath, makeReferencePackage());
    const source = { kind: 'package' as const, packagePath };
    const first = await evalExperimentCreate({
      project: 'farmslot-farm',
      taskProfile: 'fix-bug',
      source,
      datasetId: 'template-regression-smoke',
      datasetItemId: 'bugfix-pr-123',
    });
    evalRoots.add(path.dirname(path.dirname(first.experimentManifestPath)));
    const repeat = await evalExperimentCreate({
      project: 'farmslot-farm',
      taskProfile: 'fix-bug',
      source,
      datasetId: 'template-regression-smoke',
      datasetItemId: 'bugfix-pr-123',
    });
    const differentDataset = await evalExperimentCreate({
      project: 'farmslot-farm',
      taskProfile: 'fix-bug',
      source,
      datasetId: 'template-regression-expanded',
      datasetItemId: 'bugfix-pr-123',
    });
    const otherDatasetItem = await evalExperimentCreate({
      project: 'farmslot-farm',
      taskProfile: 'fix-bug',
      source,
      datasetId: 'template-regression-smoke',
      datasetItemId: 'bugfix-pr-456',
    });
    evalRoots.add(path.dirname(path.dirname(otherDatasetItem.experimentManifestPath)));

    assert.equal(first.experimentKey, repeat.experimentKey);
    assert.equal(first.experimentKey, differentDataset.experimentKey);
    assert.equal(first.experimentManifest.datasetId, 'template-regression-smoke');
    assert.equal(differentDataset.experimentManifest.datasetId, 'template-regression-expanded');
    assert.equal(first.experimentManifest.datasetItemId, 'bugfix-pr-123');
    assert.equal(first.experimentManifest.case.caseId, 'bugfix-pr-123');
    assert.notEqual(first.experimentKey, otherDatasetItem.experimentKey);
    assert.equal(otherDatasetItem.experimentManifest.datasetItemId, 'bugfix-pr-456');
    assert.equal(
      computeExperimentKey({
        project: first.experimentManifest.project,
        source: first.experimentManifest.case.source,
        taskProfile: first.experimentManifest.case.taskProfile,
        objectiveHash: first.experimentManifest.case.objectiveHash,
        rubricId: first.experimentManifest.rubric.rubricId,
        rubricVersion: first.experimentManifest.rubric.rubricVersion,
        datasetId: first.experimentManifest.datasetId,
        datasetItemId: first.experimentManifest.datasetItemId,
      }),
      first.experimentKey,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    for (const evalRoot of evalRoots) {
      await rm(evalRoot, { recursive: true, force: true });
    }
  }
});

test('evalExperimentCreate hydrates prior-run references from the original PR family diff and evidence', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'farmslot-eval-prior-run-family-reference-'));
  const evalRoots = new Set<string>();
  const runIds: string[] = [];
  t.after(async () => {
    for (const runId of runIds.reverse()) {
      if (getRun(runId)) await deleteRun(runId);
    }
    await rm(root, { recursive: true, force: true });
    for (const evalRoot of evalRoots) {
      await rm(evalRoot, { recursive: true, force: true });
    }
  });

  const familyId = 'family-prior-reference';
  const originalDir = path.join(root, 'original');
  const prCompleteDir = path.join(root, 'pr-complete');
  await writeEvalTestFile(originalDir, 'TASK.md', '# Original');
  await writeEvalTestFile(originalDir, 'artifacts/report.md', 'original report');
  await writeEvalTestFile(originalDir, 'artifacts/after.png', 'png');
  await writeEvalTestFile(prCompleteDir, 'TASK.md', '# PR complete');
  await writeEvalTestFile(prCompleteDir, 'inputs/diff.txt', 'diff --git a/src/a.ts b/src/a.ts');
  await writeEvalTestFile(
    prCompleteDir,
    'inputs/diff-stat.json',
    JSON.stringify({
      source: 'artifact',
      available: true,
      files: 3,
      additions: 236,
      deletions: 66,
      kind: 'review-input',
      artifactPath: 'inputs/diff.txt',
      repository: 'example-org/example-browser',
      prNumber: 42284,
      baseRef: 'main',
      baseSha: 'base-sha',
      headSha: 'head-sha',
      capturedAt: '2026-05-01T00:00:00.000Z',
    }),
  );

  const original = createRun({
    project: 'farmslot-farm',
    flowType: 'fix-bug',
    mode: 'interactive',
    ticketOrPr: 'PROJ-2947',
    familyId,
    taskFile: path.join(originalDir, 'TASK.md'),
    runner: 'codex',
  });
  runIds.push(original.id);
  updateRun(original.id, {
    status: 'done',
    prNumber: 42284,
    completedAt: '2026-05-01T00:00:00.000Z',
  });
  const follow = createRun({
    project: 'farmslot-farm',
    flowType: 'pr-complete',
    mode: 'interactive',
    ticketOrPr: 'example-org/example-browser#42284',
    familyId,
    parentRunId: original.id,
    taskFile: path.join(prCompleteDir, 'TASK.md'),
    runner: 'codex',
  });
  runIds.push(follow.id);
  updateRun(follow.id, {
    status: 'done',
    prNumber: 42284,
    completedAt: '2026-05-01T00:10:00.000Z',
  });

  const result = await evalExperimentCreate({
    project: 'farmslot-farm',
    taskProfile: 'fix-bug',
    source: { kind: 'prior-run', runId: original.id },
    datasetItemId: 'bugfix-pr-42284',
  });
  evalRoots.add(path.dirname(path.dirname(result.experimentManifestPath)));

  assert.equal(result.referencePackage.diff.files, 3);
  assert.equal(result.referencePackage.diff.additions, 236);
  assert.equal(result.referencePackage.diff.kind, 'review-input');
  assert.equal(result.referencePackage.missingData.includes('reference-diff-missing'), false);
  assert.equal(
    result.referencePackage.validationEvidence.some(
      (artifact) => artifact.runId === original.id && artifact.path === 'artifacts/report.md',
    ),
    true,
  );
  assert.equal(
    result.referencePackage.visualEvidence.some(
      (media) =>
        media.artifact.runId === original.id && media.artifact.path === 'artifacts/after.png',
    ),
    true,
  );
});

test('evalExperimentCreate rejects stale manifests with mismatched experiment keys', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'farmslot-eval-stale-manifest-'));
  const evalRoots = new Set<string>();
  try {
    const packagePath = path.join(root, 'reference.result-package.json');
    await writeResultPackageManifest(packagePath, makeReferencePackage());
    const source = { kind: 'package' as const, packagePath };
    const first = await evalExperimentCreate({
      project: 'farmslot-farm',
      taskProfile: 'fix-bug',
      source,
    });
    evalRoots.add(path.dirname(path.dirname(first.experimentManifestPath)));
    await writeEvalExperimentManifest(first.experimentManifestPath, {
      ...first.experimentManifest,
      experimentKey: 'stale-dataset-folded-key',
    });
    await assert.rejects(
      () => evalExperimentCreate({ project: 'farmslot-farm', taskProfile: 'fix-bug', source }),
      /stale experimentKey.*Delete the stale eval experiment directory/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    for (const evalRoot of evalRoots) {
      await rm(evalRoot, { recursive: true, force: true });
    }
  }
});

test('evalTrialStart rejects malformed axes before dispatch', async () => {
  await assert.rejects(
    () =>
      evalTrialStart(
        {
          project: 'farmslot-farm',
          experimentManifestPath: '/tmp/missing-eval.json',
          axes: {
            // @ts-expect-error negative runtime validation: template axes require structured metadata.
            template: 'bad-shape',
          },
        },
        () => {},
      ),
    /Invalid candidate axes/,
  );
});

test('harnessLifecycleForAxes preserves explicit local harness paths', () => {
  const lifecycle = harnessLifecycleForAxes('example-mobile-farm', {
    harness: { path: '/tmp/recipe-harness', version: 'mobile' },
  });

  assert.equal(lifecycle?.source, '/tmp/recipe-harness');
  assert.equal(lifecycle?.adapter, 'mobile');
});

test('harnessLifecycleForAxes treats full sha harness refs as resolved provenance', () => {
  const sha = '0123456789abcdef0123456789abcdef01234567';
  const lifecycle = harnessLifecycleForAxes('example-mobile-farm', {
    harness: { ref: sha, version: 'mobile' },
  });

  assert.equal(lifecycle?.requestedRef, sha);
  assert.equal(lifecycle?.resolvedSha, sha);
});

test('harnessLifecycleForAxes rejects abbreviated harness commit refs early', () => {
  assert.throws(
    () =>
      harnessLifecycleForAxes('example-mobile-farm', {
        harness: { ref: 'cb82213', version: 'mobile' },
      }),
    /abbreviated commit SHA/,
  );
});

test('evalTrialStart creates a new eval-family candidate without original parent binding', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'farmslot-eval-trial-startref-'));
  const runIds: string[] = [];
  const taskDirs: string[] = [];
  t.after(async () => {
    for (const runId of runIds.reverse()) {
      if (getRun(runId)) {
        updateRun(runId, { status: 'done', completedAt: new Date().toISOString() });
        await deleteRun(runId);
      }
    }
    await rm(root, { recursive: true, force: true });
    for (const taskDir of taskDirs) {
      await rm(taskDir, { recursive: true, force: true });
    }
  });

  const referencePackagePath = path.join(root, 'reference.result-package.json');
  const referencePackage = await writeResultPackageManifest(referencePackagePath, {
    ...makeReferencePackage(),
    source: { kind: 'prior-run', runId: 'original-run', familyId: 'original-family' },
  });
  const experimentKey = `experiment-key-startref-${Date.now()}`;
  const experimentManifestPath = path.join(root, 'experiment-manifest.json');
  const experimentManifest: EvalExperimentManifest = {
    version: 1,
    kind: 'eval-experiment',
    experimentId: 'experiment-startref',
    experimentKey,
    createdAt: '2026-05-09T00:00:00.000Z',
    updatedAt: '2026-05-09T00:00:01.000Z',
    project: 'farmslot-farm',
    familyId: 'eval-family-startref',
    case: {
      caseId: 'case-original-run',
      source: referencePackage.source,
      taskProfile: 'fix-bug',
      objectiveHash: 'objective-1',
      referencePackageId: referencePackage.packageId,
      referencePackageHash: referencePackage.packageHash,
      referencePackagePath,
    },
    rubric: {
      taskProfile: 'fix-bug',
      rubricId: 'eval-default',
      rubricVersion: '1',
      requiredEvidence: [],
    },
    candidateStrategies: [],
    trials: [],
    missingData: [],
  };
  await writeEvalExperimentManifest(experimentManifestPath, experimentManifest);

  const previousDisableEngine = process.env.FARMSLOT_DISABLE_RUN_ENGINE_START;
  process.env.FARMSLOT_DISABLE_RUN_ENGINE_START = '1';
  let result: Awaited<ReturnType<typeof evalTrialStart>>;
  try {
    result = await evalTrialStart(
      {
        project: 'farmslot-farm',
        experimentManifestPath,
        axes: {
          template: { path: 'templates/worker/fix-bug.md' },
          harness: {
            version: 'mobile',
            ref: '2ceae4a099afcb183ae475d8b2724dd87a3f8645',
            hash: '2ceae4a099afcb183ae475d8b2724dd87a3f8645',
          },
          model: { name: 'gpt-5.5' },
        },
        label: 'candidate start ref',
        variant: 'candidate-start-ref',
        startRef: 'release/v1.0.0',
        runner: 'codex',
        model: 'gpt-5.5',
        slotId: 'demo-ff-1',
      },
      () => {},
    );
  } finally {
    if (previousDisableEngine === undefined) delete process.env.FARMSLOT_DISABLE_RUN_ENGINE_START;
    else process.env.FARMSLOT_DISABLE_RUN_ENGINE_START = previousDisableEngine;
  }
  if (result.run) runIds.push(result.run.id);

  assert.equal(result.deduped, false);
  assert.equal(result.run?.familyId, 'eval-family-startref');
  assert.equal(result.run?.parentRunId, null);
  assert.equal(result.run?.lane, 'comparison');
  assert.equal(result.run?.completionPolicy, 'artifact-only');
  assert.equal(result.run?.flowType, 'fix-bug');
  assert.equal(result.run?.ticketOrPr.startsWith('EVAL-'), true);
  assert.equal(result.run?.startRef?.requestedRef, 'release/v1.0.0');
  assert.deepEqual(result.run?.startRef?.source, { kind: 'manual' });
  assert.equal(result.candidatePackage.source.kind, 'prior-run');
  assert.deepEqual(result.candidatePackage.productRef, {
    requestedRef: 'release/v1.0.0',
    source: 'eval-candidate',
  });
  assert.equal(result.candidatePackage.harnessLifecycle?.adapter, 'mobile');
  assert.equal(result.candidatePackage.harnessLifecycle?.source, 'recipe-harness');
  assert.equal(
    result.candidatePackage.harnessLifecycle?.requestedRef,
    '2ceae4a099afcb183ae475d8b2724dd87a3f8645',
  );
  assert.equal(result.candidatePackage.harnessLifecycle?.installStatus, 'pending');
  assert.equal(result.candidatePackage.harnessLifecycle?.verifyStatus, 'pending');
  assert.equal(result.candidatePackage.harnessLifecycle?.cleanupStatus, 'pending');
  assert.equal(result.candidatePackage.missingData.includes('harness-install-pending'), true);
  assert.equal(result.candidatePackage.missingData.includes('harness-verify-pending'), true);
  assert.equal(result.candidatePackage.missingData.includes('harness-cleanup-pending'), true);
  assert.equal(result.experimentManifest.trials[0]?.runId, result.run?.id);
  const candidateDir = path.dirname(path.dirname(path.dirname(result.candidatePackagePath)));
  const startRefInput = JSON.parse(
    await readFile(path.join(candidateDir, 'inputs', 'candidate-start-ref.json'), 'utf-8'),
  ) as Record<string, unknown>;
  assert.deepEqual(startRefInput, { requestedRef: 'release/v1.0.0', source: 'eval-candidate' });
  assert.equal(result.taskPath, undefined);
  const normalTaskPath = await writeTaskFile(result.run!, { skipCollisionCheck: true });
  taskDirs.push(path.dirname(normalTaskPath));
  const normalTask = await readFile(normalTaskPath, 'utf-8');
  assert.match(normalTask, /^# /);
  assert.match(normalTask, /Artifact-only replay guardrails/);
  assert.doesNotMatch(normalTask, /Worker: Eval Candidate Replay/);
  assert.doesNotMatch(normalTask, /Candidate axes/);
  assert.doesNotMatch(normalTask, /Experiment manifest:/);
  const templateInput = await readFile(
    path.join(candidateDir, 'inputs', 'candidate-template.md'),
    'utf-8',
  );
  assert.match(templateInput, /Worker/i);
  assert.equal(typeof result.candidatePackage.templateProvenance?.contentHash, 'string');
});

test('evalTrialStart rejects auto replay when the Reference has no base commit', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'farmslot-eval-trial-missing-startref-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const referencePackagePath = path.join(root, 'reference.result-package.json');
  const referencePackage = await writeResultPackageManifest(referencePackagePath, {
    ...makeReferencePackage(),
    source: { kind: 'git-ref', ref: 'main', repository: 'owner/repo' },
    baseline: undefined,
    diff: unavailableDiff('reference-base-missing'),
  });
  const experimentManifestPath = path.join(root, 'experiment-manifest.json');
  await writeEvalExperimentManifest(experimentManifestPath, {
    version: 1,
    kind: 'eval-experiment',
    experimentId: 'experiment-missing-startref',
    experimentKey: `experiment-key-missing-startref-${Date.now()}`,
    createdAt: '2026-05-09T00:00:00.000Z',
    updatedAt: '2026-05-09T00:00:01.000Z',
    project: 'farmslot-farm',
    familyId: 'eval-family-missing-startref',
    case: {
      caseId: 'case-missing-startref',
      source: referencePackage.source,
      taskProfile: 'fix-bug',
      objectiveHash: 'objective-1',
      referencePackageId: referencePackage.packageId,
      referencePackageHash: referencePackage.packageHash,
      referencePackagePath,
    },
    rubric: {
      taskProfile: 'fix-bug',
      rubricId: 'eval-default',
      rubricVersion: '1',
      requiredEvidence: [],
    },
    candidateStrategies: [],
    trials: [],
    missingData: [],
  });

  await assert.rejects(
    () =>
      evalTrialStart(
        {
          project: 'farmslot-farm',
          experimentManifestPath,
          axes: {
            template: { path: 'templates/fix-bug.md', hash: 'candidate' },
            model: { name: 'gpt-5.5' },
          },
          runner: 'codex',
          model: 'gpt-5.5',
        },
        () => {},
      ),
    /requires a concrete reference base commit\/startRef/,
  );
});

test('evalTrialStart reuses a prior run startRef instead of falling back to main', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'farmslot-eval-trial-prior-run-startref-'));
  const originalRun = createRun({
    project: 'farmslot-farm',
    flowType: 'fix-bug',
    ticketOrPr: 'BUG-123',
    lane: 'comparison',
    variant: 'original-startref',
    completionPolicy: 'artifact-only',
    startRef: '0123456789abcdef0123456789abcdef01234567',
    runner: 'codex',
    model: 'gpt-5.5',
  });
  updateRun(originalRun.id, {
    status: 'done',
    completedAt: new Date().toISOString(),
    startRef: {
      requestedRef: '0123456789abcdef0123456789abcdef01234567',
      source: { kind: 'merged-pr', repo: 'owner/repo', prNumber: 123 },
    },
  });
  t.after(async () => {
    if (getRun(originalRun.id)) {
      updateRun(originalRun.id, { status: 'done', completedAt: new Date().toISOString() });
      await deleteRun(originalRun.id);
    }
    await rm(root, { recursive: true, force: true });
  });

  const referencePackagePath = path.join(root, 'reference.result-package.json');
  const referencePackage = await writeResultPackageManifest(referencePackagePath, {
    ...makeReferencePackage(),
    source: { kind: 'prior-run', runId: originalRun.id, familyId: originalRun.familyId },
    baseline: undefined,
    diff: unavailableDiff('prior-run-diff-missing'),
  });
  const experimentManifestPath = path.join(root, 'experiment-manifest.json');
  await writeEvalExperimentManifest(experimentManifestPath, {
    version: 1,
    kind: 'eval-experiment',
    experimentId: 'experiment-prior-run-startref',
    experimentKey: `experiment-key-prior-run-startref-${Date.now()}`,
    createdAt: '2026-05-09T00:00:00.000Z',
    updatedAt: '2026-05-09T00:00:01.000Z',
    project: 'farmslot-farm',
    familyId: 'eval-family-prior-run-startref',
    case: {
      caseId: 'case-prior-run-startref',
      source: referencePackage.source,
      taskProfile: 'fix-bug',
      objectiveHash: 'objective-1',
      referencePackageId: referencePackage.packageId,
      referencePackageHash: referencePackage.packageHash,
      referencePackagePath,
    },
    rubric: {
      taskProfile: 'fix-bug',
      rubricId: 'eval-default',
      rubricVersion: '1',
      requiredEvidence: [],
    },
    candidateStrategies: [],
    trials: [],
    missingData: [],
  });

  const previousDisableEngine = process.env.FARMSLOT_DISABLE_RUN_ENGINE_START;
  process.env.FARMSLOT_DISABLE_RUN_ENGINE_START = '1';
  let result: Awaited<ReturnType<typeof evalTrialStart>>;
  try {
    result = await evalTrialStart(
      {
        project: 'farmslot-farm',
        experimentManifestPath,
        axes: {
          template: { path: 'templates/fix-bug.md', hash: 'candidate' },
          model: { name: 'gpt-5.5' },
        },
        runner: 'codex',
        model: 'gpt-5.5',
      },
      () => {},
    );
  } finally {
    if (previousDisableEngine === undefined) delete process.env.FARMSLOT_DISABLE_RUN_ENGINE_START;
    else process.env.FARMSLOT_DISABLE_RUN_ENGINE_START = previousDisableEngine;
  }
  if (result.run) {
    updateRun(result.run.id, { status: 'done', completedAt: new Date().toISOString() });
    await deleteRun(result.run.id);
  }

  assert.equal(result.run?.startRef?.requestedRef, '0123456789abcdef0123456789abcdef01234567');
  assert.deepEqual(result.run?.startRef?.source, {
    kind: 'merged-pr',
    repo: 'owner/repo',
    prNumber: 123,
  });
  assert.equal(result.run?.completionPolicy, 'artifact-only');
  assert.equal(result.run?.lane, 'comparison');
  assert.equal(result.run?.flowType, 'fix-bug');
});

test('evalTrialStart automatically replays from the reference base commit when available', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'farmslot-eval-trial-auto-startref-'));
  const runIds: string[] = [];
  t.after(async () => {
    for (const runId of runIds.reverse()) {
      if (getRun(runId)) {
        updateRun(runId, { status: 'done', completedAt: new Date().toISOString() });
        await deleteRun(runId);
      }
    }
    await rm(root, { recursive: true, force: true });
  });

  const baseSha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const headSha = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const referencePackagePath = path.join(root, 'reference.result-package.json');
  const referencePackage = await writeResultPackageManifest(referencePackagePath, {
    ...makeReferencePackage(),
    source: {
      kind: 'merged-pr',
      repo: 'owner/repo',
      prNumber: 123,
      baseSha,
      headSha,
      baseRef: 'main',
      headRef: 'fix/perps',
    },
    diff: {
      source: 'artifact',
      available: true,
      files: 1,
      additions: 2,
      deletions: 1,
      kind: 'contribution',
      baseRef: 'main',
      baseSha,
      headRef: 'fix/perps',
      headSha,
      capturedAt: '2026-05-09T00:00:01.000Z',
      repository: 'owner/repo',
      prNumber: 123,
    },
  });
  const experimentManifestPath = path.join(root, 'experiment-manifest.json');
  const experimentManifest: EvalExperimentManifest = {
    version: 1,
    kind: 'eval-experiment',
    experimentId: 'experiment-auto-startref',
    experimentKey: `experiment-key-auto-startref-${Date.now()}`,
    createdAt: '2026-05-09T00:00:00.000Z',
    updatedAt: '2026-05-09T00:00:01.000Z',
    project: 'farmslot-farm',
    familyId: 'eval-family-auto-startref',
    case: {
      caseId: 'case-merged-pr',
      source: referencePackage.source,
      taskProfile: 'fix-bug',
      objectiveHash: 'objective-1',
      referencePackageId: referencePackage.packageId,
      referencePackageHash: referencePackage.packageHash,
      referencePackagePath,
    },
    rubric: {
      taskProfile: 'fix-bug',
      rubricId: 'eval-default',
      rubricVersion: '1',
      requiredEvidence: [],
    },
    candidateStrategies: [],
    trials: [],
    missingData: [],
  };
  await writeEvalExperimentManifest(experimentManifestPath, experimentManifest);
  await writeEvalTestFile(
    root,
    'inputs/reference-pr.json',
    JSON.stringify({
      title: 'fix(perps): missing latest funding payments in Activity',
      url: 'https://github.com/owner/repo/pull/123',
      body: 'Manual testing steps: Activity shows most recent funding payments.',
    }),
  );

  const previousDisableEngine = process.env.FARMSLOT_DISABLE_RUN_ENGINE_START;
  process.env.FARMSLOT_DISABLE_RUN_ENGINE_START = '1';
  const started: Array<{
    runner: string;
    model: string;
    result: Awaited<ReturnType<typeof evalTrialStart>>;
  }> = [];
  const startCandidate = async (runner: string, model: string, variant: string) => {
    const result = await evalTrialStart(
      {
        project: 'farmslot-farm',
        experimentManifestPath,
        axes: {
          template: { path: 'templates/fix-bug.md', hash: 'candidate' },
          model: { name: model },
        },
        label: `${runner} replay candidate`,
        variant,
        runner,
        model,
      },
      () => {},
    );
    started.push({ runner, model, result });
    return result;
  };
  try {
    await startCandidate('codex', 'gpt-5.5', 'codex-replay-candidate');
    await startCandidate('cursor', DEFAULT_CURSOR_MODEL, 'cursor-replay-candidate');
  } finally {
    if (previousDisableEngine === undefined) delete process.env.FARMSLOT_DISABLE_RUN_ENGINE_START;
    else process.env.FARMSLOT_DISABLE_RUN_ENGINE_START = previousDisableEngine;
  }
  assert.equal(started.length, 2);
  for (const candidate of started) {
    if (candidate.result.run) runIds.push(candidate.result.run.id);
    assert.equal(candidate.result.run?.metrics.runner, candidate.runner);
    assert.equal(candidate.result.run?.metrics.model, candidate.model);
    assert.equal(candidate.result.run?.completionPolicy, 'artifact-only');
    assert.equal(candidate.result.run?.lane, 'comparison');
    assert.equal(candidate.result.run?.startRef?.requestedRef, baseSha);
    assert.deepEqual(candidate.result.candidatePackage.productRef, {
      requestedRef: baseSha,
      source: 'eval-reference',
    });
    assert.deepEqual(candidate.result.run?.startRef?.source, {
      kind: 'merged-pr',
      repo: 'owner/repo',
      prNumber: 123,
    });
    assert.equal(
      candidate.result.run?.ticketData?.title,
      'fix(perps): missing latest funding payments in Activity',
    );
    assert.match(
      candidate.result.run?.ticketData?.description ?? '',
      /Activity shows most recent funding payments/,
    );
  }
  const candidateDir = path.dirname(
    path.dirname(path.dirname(started[0].result.candidatePackagePath)),
  );
  const startRefInput = JSON.parse(
    await readFile(path.join(candidateDir, 'inputs', 'candidate-start-ref.json'), 'utf-8'),
  ) as Record<string, unknown>;
  assert.deepEqual(startRefInput, { requestedRef: baseSha, source: 'eval-reference' });
});

test('candidateVariant always preserves the axis fingerprint suffix', () => {
  const fingerprint = 'abcdef1234567890fedcba9876543210';

  assert.equal(
    candidateVariant({ variant: 'current-abcdef12' }, fingerprint),
    'current-abcdef12-abcdef12',
  );
  assert.equal(
    candidateVariant(
      { label: 'this label is intentionally very long so it must be clamped before suffixing' },
      fingerprint,
    ).endsWith('-abcdef12'),
    true,
  );
  assert.equal(
    candidateVariant({}, fingerprint, 'trial-1234567890-extra'),
    'eval-abcdef12-trial-1234567890',
  );
});

test('evalTrialStart treats explicit trialId as an idempotency key', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'farmslot-eval-trial-dedupe-'));
  try {
    const baseSha = 'cccccccccccccccccccccccccccccccccccccccc';
    const referencePackagePath = path.join(root, 'reference.result-package.json');
    const referencePackage = await writeResultPackageManifest(referencePackagePath, {
      ...makeReferencePackage(),
      source: { kind: 'git-ref', ref: 'main', repository: 'owner/repo', baseSha },
      baseline: { baseSha, capturedAt: '2026-05-09T00:00:01.000Z', source: 'local-git' },
    });
    const axes = {
      template: { path: 'templates/fix-bug.md', hash: 'template-new' },
      model: { name: 'gpt-5.5' },
    };
    const candidateStrategyFingerprint = computeCandidateStrategyFingerprint({
      axes,
      taskProfile: 'fix-bug',
      startRef: baseSha,
    });
    const trialId = 'trial-1';
    const candidatePackagePath = path.join(root, 'candidate.result-package.json');
    const candidatePackage = await writeResultPackageManifest(candidatePackagePath, {
      ...makeReferencePackage(),
      packageId: packageIdFor({
        experimentKey: 'experiment-key-1',
        role: 'candidate',
        candidateStrategyFingerprint,
        trialId: `trial-${candidateStrategyFingerprint.slice(0, 12)}-${trialId}`,
      }),
      status: 'draft',
      finalizedAt: undefined,
      role: 'candidate',
      axes,
      missingData: ['candidate-run-pending'],
    });
    const normalizedTrialId = `trial-${candidateStrategyFingerprint.slice(0, 12)}-${trialId}`;
    const strategyId = `strategy-${candidateStrategyFingerprint.slice(0, 12)}`;
    const experimentManifestPath = path.join(root, 'experiment-manifest.json');
    const experimentManifest: EvalExperimentManifest = {
      version: 1,
      kind: 'eval-experiment',
      experimentId: 'experiment-1',
      experimentKey: 'experiment-key-1',
      createdAt: '2026-05-09T00:00:00.000Z',
      updatedAt: '2026-05-09T00:00:01.000Z',
      project: 'farmslot-farm',
      familyId: 'family-1',
      case: {
        caseId: 'case-1',
        source: referencePackage.source,
        taskProfile: 'fix-bug',
        objectiveHash: 'objective-1',
        referencePackageId: referencePackage.packageId,
        referencePackageHash: referencePackage.packageHash,
        referencePackagePath,
      },
      rubric: {
        taskProfile: 'fix-bug',
        rubricId: 'eval-default',
        rubricVersion: '1',
        requiredEvidence: [],
      },
      candidateStrategies: [{ strategyId, label: 'candidate', candidateStrategyFingerprint, axes }],
      trials: [
        {
          trialId: normalizedTrialId,
          strategyId,
          caseId: 'case-1',
          status: 'running',
          packageId: candidatePackage.packageId,
          packageHash: candidatePackage.packageHash,
          packagePath: candidatePackagePath,
          runId: 'missing-run',
          missingData: ['candidate-run-pending'],
        },
      ],
      missingData: [],
    };
    await writeEvalExperimentManifest(experimentManifestPath, experimentManifest);

    const result = await evalTrialStart(
      { project: 'farmslot-farm', experimentManifestPath, axes, trialId },
      () => {},
    );

    assert.equal(result.deduped, true);
    assert.equal(result.strategyId, strategyId);
    assert.equal(result.trialId, normalizedTrialId);
    assert.equal(result.candidatePackagePath, candidatePackagePath);
    assert.equal(result.candidatePackage.packageId, candidatePackage.packageId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
