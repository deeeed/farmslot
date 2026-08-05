import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildFamilyObservabilitySnapshotFromRuns } from './snapshot.js';
import { makeRecipeJson, makeRun, writeArtifact } from './test-fixtures.js';

test('snapshot aggregates family runs, artifacts, and learnings from persisted files', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'family-observability-'));
  const rootDir = path.join(base, 'root');
  const followUpDir = path.join(base, 'followup');

  await writeArtifact(rootDir, 'TASK.md', '# Root task');
  await writeArtifact(rootDir, 'artifacts/report.md', 'Root report\nMore detail');
  await writeArtifact(rootDir, 'artifacts/learnings.md', 'Worker learned a useful thing');
  await writeArtifact(
    rootDir,
    'artifacts/recipe.json',
    makeRecipeJson({
      start: { action: 'navigate', intent: 'Open the test target.', next: 'done' },
      done: { action: 'end', status: 'pass' },
    }),
  );
  await writeArtifact(rootDir, 'artifacts/recipe-coverage.md', '24/25 passed');
  await writeArtifact(
    rootDir,
    'artifacts/recipe-quality.json',
    JSON.stringify(
      {
        version: 1,
        verdict: 'pass',
        compact: {
          verdict: 'PASS',
          reasons: ['Root recipe quality is canonical.'],
          better_version_guidance: [],
        },
        dimensions: {},
        structural_findings: [],
        contextual_findings: [],
        suggested_recipe_delta: [],
        training_fields: {
          project: 'example-mobile-farm',
          flow_type: 'fix-bug',
          proof_mode: 'mixed',
        },
        meta: {
          producer: 'gateway',
          fallback_used: false,
          legacy_task: false,
          artifact_required: true,
          source_signals: ['recipe-quality.json'],
        },
      },
      null,
      2,
    ),
  );
  await writeArtifact(rootDir, 'artifacts/after.png', 'png');
  await writeArtifact(rootDir, 'artifacts/evidence/review.mp4', 'video');
  await writeArtifact(followUpDir, 'TASK.md', '# Follow-up task');
  await writeArtifact(
    followUpDir,
    'artifacts/family-scope.json',
    JSON.stringify({ scopeVerdict: 'full-scope-addressed', notes: 'Follow-up preserved scope.' }),
  );
  await writeArtifact(followUpDir, 'artifacts/review.md', 'Review approved with one nit.');
  await writeArtifact(
    followUpDir,
    'artifacts/review-feedback.md',
    'Follow-up feedback: cover zero balance path.',
  );
  await writeArtifact(
    followUpDir,
    'artifacts/line-comments.json',
    JSON.stringify([{ path: 'src/a.ts', line: 12, body: 'Add edge case' }]),
  );

  const root = makeRun({
    id: 'root-run',
    familyId: 'family-xyz',
    familyRootTicketOrPr: 'PROJ-42',
    ticketOrPr: 'PROJ-42',
    taskFile: path.join(rootDir, 'TASK.md'),
    branch: 'fix/proj-42',
    prNumber: 42,
    steps: [
      {
        name: 'complete',
        status: 'done',
        outputs: {
          diffStat: { files: 3, additions: 20, deletions: 5 },
          artifacts: [{ path: 'artifacts/recipe.json', purpose: 'recipe' }],
        },
      },
    ],
  });
  const followUp = makeRun({
    id: 'follow-up',
    familyId: 'family-xyz',
    familyRootTicketOrPr: 'PROJ-42',
    parentRunId: 'root-run',
    ticketOrPr: 'owner/repo#42',
    flowType: 'pr-complete',
    taskFile: path.join(followUpDir, 'TASK.md'),
    summary: 'Follow-up summary',
    updatedAt: '2026-04-15T02:00:00.000Z',
    steps: [
      {
        name: 'self-review',
        status: 'done',
        outputs: {
          verdict: 'issues',
          issues: [{ file: 'src/a.ts', description: 'Add edge case', line: 12 }],
        },
      },
    ],
  });

  const snapshot = await buildFamilyObservabilitySnapshotFromRuns([root, followUp]);

  assert.equal(snapshot.familyId, 'family-xyz');
  assert.equal(snapshot.familyRunCount, 2);
  assert.equal(snapshot.latestRunId, 'follow-up');
  assert.equal(snapshot.recipeQuality.semantic, 'good');
  assert.equal(snapshot.runs[1].recipeQualityArtifact?.compact.verdict, 'PASS');
  assert.equal(snapshot.diffStat.available, true);
  assert.equal(
    snapshot.evidence.some((artifact) => artifact.path === 'artifacts/after.png'),
    true,
  );
  assert.equal(
    snapshot.evidence.some((artifact) => artifact.path === 'artifacts/evidence/review.mp4'),
    true,
  );
  assert.equal(
    snapshot.learnings.some((entry) => entry.source === 'worker-learnings'),
    true,
  );
  assert.equal(
    snapshot.learnings.some((entry) => entry.source === 'self-review'),
    true,
  );
  assert.equal(
    snapshot.learnings.some((entry) => entry.title === 'Review summary'),
    true,
  );
  assert.equal(
    snapshot.learnings.some((entry) => entry.title === 'Review feedback'),
    true,
  );
  assert.equal(
    snapshot.learnings.some((entry) => entry.title === 'Review line comments'),
    true,
  );
  assert.equal(snapshot.runs[0].familyScope?.scopeVerdict, 'full-scope-addressed');
});

test('snapshot projects eval package manifests with package evidence rows', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'family-observability-experiment-manifest-'));
  const evalDir = path.join(base, 'candidate');
  const refPackagePath = path.join(
    evalDir,
    'artifacts',
    'packages',
    'reference.result-package.json',
  );
  const candidatePackagePath = path.join(
    evalDir,
    'artifacts',
    'packages',
    'candidate.result-package.json',
  );
  const malformedPackagePath = path.join(
    evalDir,
    'artifacts',
    'packages',
    'malformed.result-package.json',
  );
  await writeArtifact(evalDir, 'TASK.md', '# Eval candidate');
  await writeArtifact(
    evalDir,
    'artifacts/packages/reference.result-package.json',
    JSON.stringify(
      {
        version: 1,
        kind: 'result-package',
        packageId: 'pkg-ref',
        packageHash: 'hash-ref',
        status: 'final',
        createdAt: '2026-05-09T00:00:00.000Z',
        finalizedAt: '2026-05-09T00:00:01.000Z',
        project: 'example-mobile-farm',
        familyId: 'family-kernel',
        objectiveHash: 'objective-1',
        taskProfile: 'fix-bug',
        source: { kind: 'merged-pr', repo: 'owner/repo', prNumber: 123 },
        role: 'reference',
        diff: {
          source: 'artifact',
          available: true,
          files: 2,
          additions: 4,
          deletions: 1,
          kind: 'contribution',
        },
        axes: { template: { path: 'fix-bug.md', hash: 'old' } },
        visualEvidence: [],
        validationEvidence: [],
        reviewEvidence: [],
        outcomeClaims: [],
        missingData: [],
      },
      null,
      2,
    ),
  );
  await writeArtifact(evalDir, 'artifacts/packages/malformed.result-package.json', '{ not json');
  await writeArtifact(
    evalDir,
    'artifacts/packages/candidate.result-package.json',
    JSON.stringify(
      {
        version: 1,
        kind: 'result-package',
        packageId: 'pkg-candidate',
        packageHash: 'hash-candidate',
        status: 'final',
        createdAt: '2026-05-09T00:00:00.000Z',
        finalizedAt: '2026-05-09T00:03:00.000Z',
        project: 'example-mobile-farm',
        familyId: 'family-kernel',
        objectiveHash: 'objective-1',
        taskProfile: 'fix-bug',
        source: { kind: 'merged-pr', repo: 'owner/repo', prNumber: 123 },
        runId: 'candidate-run',
        role: 'candidate',
        diff: {
          source: 'artifact',
          available: true,
          files: 1,
          additions: 2,
          deletions: 0,
          kind: 'contribution',
        },
        axes: { template: { path: 'fix-bug.md', hash: 'old' }, model: { name: 'gpt-5.5' } },
        visualEvidence: [],
        validationEvidence: [
          {
            runId: 'candidate-run',
            familyId: 'family-kernel',
            path: 'artifacts/report.md',
            purpose: 'report',
            source: 'task-artifact',
          },
        ],
        reviewEvidence: [],
        outcomeClaims: [],
        metrics: { durationMs: 180000, costEstimate: 0.42 },
        missingData: ['visual-evidence-missing'],
      },
      null,
      2,
    ),
  );
  await writeArtifact(
    evalDir,
    'artifacts/experiment-manifest.json',
    JSON.stringify(
      {
        version: 1,
        kind: 'eval-experiment',
        experimentId: 'experiment-kernel-1',
        experimentKey: 'experiment-key-1',
        createdAt: '2026-05-09T00:00:00.000Z',
        updatedAt: '2026-05-09T00:01:00.000Z',
        project: 'example-mobile-farm',
        familyId: 'family-kernel',
        case: {
          caseId: 'case-kernel-1',
          source: { kind: 'merged-pr', repo: 'owner/repo', prNumber: 123 },
          taskProfile: 'fix-bug',
          objectiveHash: 'objective-1',
          referencePackageId: 'pkg-ref',
          referencePackageHash: 'hash-ref',
          referencePackagePath: refPackagePath,
        },
        rubric: {
          taskProfile: 'fix-bug',
          rubricId: 'eval-default',
          rubricVersion: '1',
          requiredEvidence: [],
        },
        candidateStrategies: [
          {
            strategyId: 'strategy-old',
            label: 'old template',
            candidateStrategyFingerprint: 'axis-old',
            axes: { template: { path: 'fix-bug.md', hash: 'old' } },
          },
          {
            strategyId: 'strategy-draft',
            label: 'draft template',
            candidateStrategyFingerprint: 'axis-draft',
            axes: { template: { path: 'fix-bug.md', hash: 'draft' } },
          },
          {
            strategyId: 'strategy-bad',
            label: 'bad package',
            candidateStrategyFingerprint: 'axis-bad',
            axes: { template: { path: 'fix-bug.md', hash: 'bad' } },
          },
        ],
        trials: [
          {
            trialId: 'trial-old',
            strategyId: 'strategy-old',
            caseId: 'case-kernel-1',
            status: 'final',
            packageId: 'pkg-candidate',
            packageHash: 'hash-candidate',
            packagePath: candidatePackagePath,
            runId: 'candidate-run',
            missingData: ['visual-evidence-missing'],
          },
          {
            trialId: 'trial-draft',
            strategyId: 'strategy-draft',
            caseId: 'case-kernel-1',
            status: 'draft',
            missingData: ['candidate-run-pending'],
          },
          {
            trialId: 'trial-bad',
            strategyId: 'strategy-bad',
            caseId: 'case-kernel-1',
            status: 'final',
            packageId: 'pkg-bad',
            packageHash: 'hash-bad',
            packagePath: malformedPackagePath,
            runId: 'bad-run',
            missingData: ['result-package-invalid'],
          },
        ],
        missingData: ['visual-evidence-missing'],
      },
      null,
      2,
    ),
  );

  const run = makeRun({
    id: 'candidate-run',
    familyId: 'family-kernel',
    flowType: 'dev',
    lane: 'comparison',
    variant: 'old-template',
    ticketOrPr: 'owner/repo#123',
    taskFile: path.join(evalDir, 'TASK.md'),
    completionPolicy: 'artifact-only',
  });

  const snapshot = await buildFamilyObservabilitySnapshotFromRuns([run]);
  assert.equal(snapshot.experiments?.length, 1);
  assert.equal(snapshot.experiments?.[0]?.experimentKey, 'experiment-key-1');
  assert.equal(
    snapshot.experiments?.[0]?.candidateStrategies[0]?.candidateStrategyFingerprint,
    'axis-old',
  );
  assert.equal(snapshot.experiments?.[0]?.packages?.length, 4);
  assert.deepEqual(snapshot.experiments?.[0]?.packages?.[0]?.sourceBacklinks, [
    { kind: 'github-pr', repo: 'owner/repo', prNumber: 123, url: undefined },
  ]);
  assert.equal(snapshot.experiments?.[0]?.packages?.[1]?.status, 'final');
  assert.equal(snapshot.experiments?.[0]?.packages?.[1]?.metrics?.costEstimate, 0.42);
  assert.equal(
    snapshot.experiments?.[0]?.packages?.[2]?.diff.missingReason,
    'result-package-path-missing',
  );
  assert.equal(
    snapshot.experiments?.[0]?.packages?.[2]?.missingData.includes('result-package-path-missing'),
    true,
  );
  assert.equal(
    snapshot.experiments?.[0]?.packages?.[3]?.diff.missingReason,
    'result-package-invalid',
  );
  assert.equal(
    snapshot.experiments?.[0]?.packages?.[3]?.missingData.includes('result-package-invalid'),
    true,
  );
  assert.equal(
    snapshot.experiments?.[0]?.packages?.[3]?.missingData.some((entry) =>
      entry.startsWith('result-package-invalid:'),
    ),
    true,
  );
  assert.equal(snapshot.missingData.includes('visual-evidence-missing'), true);
  assert.equal(snapshot.missingData.includes('result-package-invalid'), true);
  assert.equal(
    snapshot.missingData.some((entry) => entry.startsWith('result-package-invalid:')),
    true,
  );
});

test('snapshot keeps the newest eval manifest for duplicate eval keys', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'family-observability-eval-newest-'));
  const olderDir = path.join(base, 'older');
  const newerDir = path.join(base, 'newer');
  const manifest = (updatedAt: string, strategies: unknown[], trials: unknown[]) => ({
    version: 1,
    kind: 'eval-experiment',
    experimentId: 'experiment-kernel-1',
    experimentKey: 'experiment-key-1',
    createdAt: '2026-05-09T00:00:00.000Z',
    updatedAt,
    project: 'example-mobile-farm',
    familyId: 'family-kernel',
    case: {
      caseId: 'case-kernel-1',
      source: { kind: 'merged-pr', repo: 'owner/repo', prNumber: 123 },
      taskProfile: 'fix-bug',
      objectiveHash: 'objective-1',
      referencePackageId: 'pkg-ref',
      referencePackageHash: 'hash-ref',
      referencePackagePath: '/tmp/ref.result-package.json',
    },
    rubric: {
      taskProfile: 'fix-bug',
      rubricId: 'eval-default',
      rubricVersion: '1',
      requiredEvidence: [],
    },
    candidateStrategies: strategies,
    trials,
    missingData: [],
  });
  await writeArtifact(olderDir, 'TASK.md', '# Older eval candidate');
  await writeArtifact(
    olderDir,
    'artifacts/experiment-manifest.json',
    JSON.stringify(
      manifest(
        '2026-05-09T00:01:00.000Z',
        [
          {
            strategyId: 'strategy-1',
            label: 'candidate 1',
            candidateStrategyFingerprint: 'axis-1',
          },
        ],
        [
          {
            trialId: 'trial-1',
            strategyId: 'strategy-1',
            caseId: 'case-kernel-1',
            status: 'running',
            packageId: 'pkg-1',
            packageHash: 'hash-1',
            packagePath: '/tmp/1.json',
            runId: 'older-run',
            missingData: [],
          },
        ],
      ),
      null,
      2,
    ),
  );
  await writeArtifact(newerDir, 'TASK.md', '# Newer eval candidate');
  await writeArtifact(
    newerDir,
    'artifacts/experiment-manifest.json',
    JSON.stringify(
      manifest(
        '2026-05-09T00:02:00.000Z',
        [
          {
            strategyId: 'strategy-1',
            label: 'candidate 1',
            candidateStrategyFingerprint: 'axis-1',
          },
          {
            strategyId: 'strategy-2',
            label: 'candidate 2',
            candidateStrategyFingerprint: 'axis-2',
          },
        ],
        [
          {
            trialId: 'trial-1',
            strategyId: 'strategy-1',
            caseId: 'case-kernel-1',
            status: 'running',
            packageId: 'pkg-1',
            packageHash: 'hash-1',
            packagePath: '/tmp/1.json',
            runId: 'older-run',
            missingData: [],
          },
          {
            trialId: 'trial-2',
            strategyId: 'strategy-2',
            caseId: 'case-kernel-1',
            status: 'running',
            packageId: 'pkg-2',
            packageHash: 'hash-2',
            packagePath: '/tmp/2.json',
            runId: 'newer-run',
            missingData: [],
          },
        ],
      ),
      null,
      2,
    ),
  );

  const older = makeRun({
    id: 'older-run',
    familyId: 'family-kernel',
    taskFile: path.join(olderDir, 'TASK.md'),
    updatedAt: '2026-05-09T00:03:00.000Z',
  });
  const newer = makeRun({
    id: 'newer-run',
    familyId: 'family-kernel',
    taskFile: path.join(newerDir, 'TASK.md'),
    updatedAt: '2026-05-09T00:02:00.000Z',
  });
  const snapshot = await buildFamilyObservabilitySnapshotFromRuns([older, newer]);

  assert.equal(snapshot.experiments?.length, 1);
  assert.deepEqual(
    snapshot.experiments?.[0]?.trials.map((trial) => trial.trialId),
    ['trial-1', 'trial-2'],
  );
});
