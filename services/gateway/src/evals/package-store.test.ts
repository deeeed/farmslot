import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  type EvalExperimentManifest,
  isResultPackageManifest,
  type ResultPackageManifest,
  type Run,
} from '@farmslot/protocol';

import { TEMPLATE_PROVENANCE_INPUT } from '../tasks/writer.js';

import {
  computeCandidateStrategyFingerprint,
  computeExperimentKey,
  computePackageHash,
  finalizeEvalResultPackageForRun,
  MAX_RESULT_PACKAGE_ARTIFACT_SCAN_FILES,
  packageIdFor,
  scanResultPackageArtifacts,
  stableJson,
  unavailableDiff,
  writeEvalExperimentManifest,
  writeResultPackageManifest,
} from './package-store.js';

function makeRun(root: string, overrides: Partial<Run> = {}): Run {
  return {
    id: overrides.id ?? 'run-1',
    familyId: overrides.familyId ?? 'family-1',
    parentRunId: overrides.parentRunId ?? null,
    familyRootTicketOrPr: overrides.familyRootTicketOrPr ?? 'owner/repo#123',
    lane: overrides.lane ?? 'validation',
    variant: overrides.variant ?? null,
    flowType: overrides.flowType ?? 'dev',
    mode: overrides.mode ?? 'validation',
    status: overrides.status ?? 'done',
    project: overrides.project ?? 'example-mobile-farm',
    ticketOrPr: overrides.ticketOrPr ?? 'owner/repo#123',
    slotId: overrides.slotId ?? 'slot-1',
    branch: overrides.branch ?? 'dev/eval',
    completionPolicy: overrides.completionPolicy ?? 'artifact-only',
    taskFile: overrides.taskFile ?? path.join(root, 'TASK.md'),
    steps: overrides.steps ?? [],
    decisions: overrides.decisions ?? [],
    metrics: overrides.metrics ?? {
      nudgeCount: 0,
      model: 'gpt-5.5',
      runner: 'codex',
      runnerSessionId: null,
      runnerSessionPath: null,
      costEstimate: 0.25,
      sessionTurns: 4,
      sessionInputTokens: 1000,
      sessionOutputTokens: 500,
      sessionTotalTokens: 1500,
    },
    createdAt: overrides.createdAt ?? '2026-05-09T00:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-05-09T00:01:00.000Z',
    completedAt: overrides.completedAt ?? '2026-05-09T00:02:00.000Z',
    engineState: overrides.engineState,
  };
}

function makePackage(overrides: Partial<ResultPackageManifest> = {}): ResultPackageManifest {
  return {
    version: 1,
    kind: 'result-package',
    packageId: 'pkg-candidate',
    packageHash: '',
    status: 'draft',
    createdAt: '2026-05-09T00:00:00.000Z',
    project: 'example-mobile-farm',
    familyId: 'family-1',
    objectiveHash: 'objective-1',
    taskProfile: 'fix-bug',
    source: {
      kind: 'merged-pr',
      repo: 'owner/repo',
      prNumber: 123,
      mergedAt: '2026-05-08T00:00:00.000Z',
      headSha: 'abc123',
    },
    runId: 'run-1',
    role: 'candidate',
    diff: unavailableDiff('pending'),
    axes: { template: { path: 'templates/fix-bug.md', hash: 'old' } },
    visualEvidence: [],
    validationEvidence: [],
    reviewEvidence: [],
    outcomeClaims: [],
    missingData: ['candidate-run-pending', 'eval-diff-pending', 'validation-evidence-missing'],
    ...overrides,
  };
}

test('stableJson normalizes key order for deterministic hashes', () => {
  assert.equal(stableJson({ b: 2, a: { d: 4, c: 3 } }), stableJson({ a: { c: 3, d: 4 }, b: 2 }));
  assert.equal(stableJson({ a: 1, b: undefined }), stableJson({ a: 1 }));
});

test('experimentKey and candidateStrategyFingerprint are content-addressed', () => {
  const source = {
    kind: 'merged-pr' as const,
    repo: 'Owner/Repo',
    prNumber: 123,
    mergeCommitSha: 'merge',
    headSha: 'head',
  };
  const a = computeExperimentKey({
    project: 'p',
    source,
    taskProfile: 'fix-bug',
    objectiveHash: 'obj',
    rubricId: 'r',
    rubricVersion: '1',
  });
  const b = computeExperimentKey({
    project: 'p',
    source: { ...source, repo: 'owner/repo' },
    taskProfile: 'fix-bug',
    objectiveHash: 'obj',
    rubricId: 'r',
    rubricVersion: '1',
  });
  assert.equal(a, b);

  const oldTemplate = computeCandidateStrategyFingerprint({
    taskProfile: 'fix-bug',
    axes: { template: { path: 'fix-bug.md', hash: 'old' }, model: { name: 'gpt-5.5' } },
  });
  const newTemplate = computeCandidateStrategyFingerprint({
    taskProfile: 'fix-bug',
    axes: { template: { path: 'fix-bug.md', hash: 'new' }, model: { name: 'gpt-5.5' } },
  });
  assert.notEqual(oldTemplate, newTemplate);
  const startA = computeCandidateStrategyFingerprint({
    taskProfile: 'fix-bug',
    axes: { model: { name: 'gpt-5.5' } },
    startRef: 'aaa111',
  });
  const startB = computeCandidateStrategyFingerprint({
    taskProfile: 'fix-bug',
    axes: { model: { name: 'gpt-5.5' } },
    startRef: 'bbb222',
  });
  assert.notEqual(startA, startB);
  assert.equal(
    packageIdFor({
      experimentKey: a,
      role: 'candidate',
      candidateStrategyFingerprint: oldTemplate,
    }),
    packageIdFor({
      experimentKey: a,
      role: 'candidate',
      candidateStrategyFingerprint: oldTemplate,
    }),
  );
});

test('package hashes ignore volatile source paths and capture timestamps', () => {
  const first = makePackage({
    source: {
      kind: 'package',
      packageId: 'pkg-ref',
      packageHash: 'hash-ref',
      packagePath: '/tmp/a/ref.json',
    },
    diff: {
      source: 'unavailable',
      available: false,
      files: 0,
      additions: 0,
      deletions: 0,
      kind: 'contribution',
      missingReason: 'pending',
      capturedAt: '2026-05-09T00:00:00.000Z',
    },
    baseline: {
      capturedAt: '2026-05-09T00:00:00.000Z',
      source: 'local-git',
      repository: 'owner/repo',
      headSha: 'base',
    },
    head: {
      capturedAt: '2026-05-09T00:00:00.000Z',
      source: 'local-git',
      repository: 'owner/repo',
      headSha: 'head',
    },
  });
  const second = makePackage({
    source: {
      kind: 'package',
      packageId: 'pkg-ref',
      packageHash: 'hash-ref',
      packagePath: '/tmp/b/ref.json',
    },
    diff: {
      source: 'unavailable',
      available: false,
      files: 0,
      additions: 0,
      deletions: 0,
      kind: 'contribution',
      missingReason: 'pending',
      capturedAt: '2026-05-10T00:00:00.000Z',
    },
    baseline: {
      capturedAt: '2026-05-10T00:00:00.000Z',
      source: 'local-git',
      repository: 'owner/repo',
      headSha: 'base',
    },
    head: {
      capturedAt: '2026-05-10T00:00:00.000Z',
      source: 'local-git',
      repository: 'owner/repo',
      headSha: 'head',
    },
  });
  assert.equal(computePackageHash(first), computePackageHash(second));
});

test('finalizeEvalResultPackageForRun hashes artifacts and updates experiment trial package hash', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'farmslot-eval-package-'));
  try {
    await mkdir(path.join(root, 'artifacts', 'packages'), { recursive: true });
    await writeFile(path.join(root, 'TASK.md'), '# Task\n');
    await writeFile(path.join(root, 'artifacts', 'report.md'), 'candidate report\n');
    await writeFile(path.join(root, 'artifacts', 'after.png'), 'png-bytes');
    await writeFile(path.join(root, 'artifacts', 'notes-before-fix.png'), 'notes-png-bytes');
    await writeFile(
      path.join(root, 'artifacts', 'diff-stat.json'),
      JSON.stringify({
        source: 'artifact',
        available: true,
        files: 1,
        additions: 2,
        deletions: 0,
        kind: 'contribution',
      }),
    );
    await mkdir(path.join(root, 'inputs'), { recursive: true });
    await writeFile(
      path.join(root, TEMPLATE_PROVENANCE_INPUT),
      JSON.stringify({
        kind: 'task-template',
        flowType: 'fix-bug',
        taskProfile: 'fix-bug',
        project: 'example-mobile-farm',
        role: 'eval-candidate',
        templatePath: 'templates/worker/fix-bug.md',
        templateName: 'fix-bug.md',
        contentHash: 'template-hash-123',
        projectRepoHeadSha: 'project-sha-123',
        source: 'current-project',
        renderedAt: '2026-05-09T00:00:00.000Z',
      }),
    );

    const packagePath = path.join(root, 'artifacts', 'packages', 'candidate.result-package.json');
    const draftPackage = await writeResultPackageManifest(
      packagePath,
      makePackage({
        evidenceRequirements: [
          { id: 'diff', label: 'Local diff captured', state: 'missing' },
          { id: 'report', label: 'Worker report captured', state: 'missing' },
          { id: 'visuals', label: 'Visual evidence captured when applicable', state: 'missing' },
        ],
      }),
    );
    const experimentManifestPath = path.join(root, 'artifacts', 'experiment-manifest.json');
    const referencePackagePath = path.join(
      root,
      'artifacts',
      'packages',
      'reference.result-package.json',
    );
    const referencePackage = await writeResultPackageManifest(
      referencePackagePath,
      makePackage({
        packageId: 'pkg-ref',
        status: 'final',
        finalizedAt: '2026-05-09T00:00:01.000Z',
        role: 'reference',
        source: {
          kind: 'merged-pr',
          repo: 'owner/repo',
          prNumber: 123,
          url: 'https://github.com/owner/repo/pull/123',
          title: 'Reference PR',
          mergedAt: '2026-05-08T00:00:00.000Z',
          headSha: 'abc123',
          baseRef: 'main',
          headRef: 'feat/ref',
        },
        diff: {
          source: 'artifact',
          available: true,
          files: 2,
          additions: 4,
          deletions: 1,
          kind: 'contribution',
        },
        missingData: [],
      }),
    );
    const experimentManifest: EvalExperimentManifest = {
      version: 1,
      kind: 'eval-experiment',
      experimentId: 'experiment-1',
      experimentKey: 'experiment-key-1',
      createdAt: '2026-05-09T00:00:00.000Z',
      updatedAt: '2026-05-09T00:00:00.000Z',
      project: 'example-mobile-farm',
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
      rubric: { taskProfile: 'fix-bug', rubricId: 'r', rubricVersion: '1', requiredEvidence: [] },
      candidateStrategies: [
        {
          strategyId: 'strategy-1',
          label: 'candidate',
          candidateStrategyFingerprint: 'axis-1',
          axes: draftPackage.axes,
        },
      ],
      trials: [
        {
          trialId: 'trial-1',
          strategyId: 'strategy-1',
          caseId: 'case-1',
          status: 'running',
          packageId: draftPackage.packageId,
          packageHash: draftPackage.packageHash,
          packagePath,
          runId: 'run-1',
          missingData: draftPackage.missingData,
        },
      ],
      missingData: [],
    };
    await writeEvalExperimentManifest(experimentManifestPath, experimentManifest);

    const run = makeRun(root, {
      engineState: {
        evalExperiment: {
          experimentId: 'experiment-1',
          experimentKey: 'experiment-key-1',
          experimentManifestPath,
          packagePath,
          candidateStrategyFingerprint: 'axis-1',
          trialId: 'trial-1',
        },
      },
    });
    const finalized = await finalizeEvalResultPackageForRun(run);
    assert(finalized);
    assert.equal(finalized.status, 'final');
    assert.equal(finalized.diff.available, true);
    assert.equal(
      finalized.validationEvidence.some(
        (artifact) => artifact.path === 'artifacts/report.md' && artifact.sha256,
      ),
      true,
    );
    assert.equal(finalized.missingData.includes('candidate-run-pending'), false);
    assert.equal(finalized.missingData.includes('template-provenance-missing'), false);
    assert.equal(finalized.axes.template?.hash, 'template-hash-123');
    assert.equal(finalized.templateProvenance?.contentHash, 'template-hash-123');
    assert.equal(isResultPackageManifest(finalized), true);
    assert.deepEqual(
      finalized.evidenceRequirements?.map((requirement) => [
        requirement.id,
        requirement.state,
        requirement.artifactPaths,
      ]),
      [
        ['diff', 'present', undefined],
        ['report', 'present', ['artifacts/report.md']],
        ['visuals', 'present', ['artifacts/after.png', 'artifacts/notes-before-fix.png']],
      ],
    );
    assert.equal(
      finalized.visualEvidence.some(
        (entry) =>
          entry.artifact.path === 'artifacts/notes-before-fix.png' && entry.role === 'eval-before',
      ),
      false,
    );
    assert.equal(
      finalized.visualEvidence.some(
        (entry) =>
          entry.artifact.path === 'artifacts/notes-before-fix.png' && entry.role === 'eval-after',
      ),
      true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('finalizeEvalResultPackageForRun rejects removed evalPackage engine state loudly', async () => {
  const run = makeRun('/tmp');
  run.engineState = {} as Run['engineState'];
  (run.engineState as Record<string, unknown>).evalPackage = {
    evalManifestPath: '/tmp/old-eval-manifest.json',
    packagePath: '/tmp/old-candidate.result-package.json',
  };

  await assert.rejects(
    () => finalizeEvalResultPackageForRun(run),
    /removed engineState\.evalPackage eval schema; recreate the experiment trial with eval\.trial\.start/,
  );
});

test('scanResultPackageArtifacts caps recursive artifact hashing', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'farmslot-eval-artifact-cap-'));
  try {
    const artifactDir = path.join(root, 'artifacts');
    await mkdir(artifactDir, { recursive: true });
    for (let index = 0; index < MAX_RESULT_PACKAGE_ARTIFACT_SCAN_FILES + 5; index += 1) {
      await writeFile(
        path.join(artifactDir, `artifact-${String(index).padStart(4, '0')}.txt`),
        `artifact ${index}\n`,
      );
    }

    const artifacts = await scanResultPackageArtifacts(root, {
      id: 'run-cap',
      familyId: 'family-cap',
    });

    assert.equal(artifacts.length, MAX_RESULT_PACKAGE_ARTIFACT_SCAN_FILES);
    assert.equal(
      artifacts.every((artifact) => artifact.sha256),
      true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
