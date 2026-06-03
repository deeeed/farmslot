import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  EvalExperimentProjection,
  FamilyObservabilityArtifact,
  ResultPackageProjection,
} from '@farmslot/protocol';

import {
  evidenceSummary,
  type FamilyOutputArtifact,
  type FamilyOutputRunSummary,
  type FamilyOutputSnapshot,
  findOutputComparisonPair,
  outputSummaryForRun,
  resultPackageAxisLabel,
  resultPackageDiffArtifact,
  resultPackageDiffLabel,
  resultPackageEvidenceLabel,
  resultPackageSourceLabel,
  runArtifactFootprint,
  selectedFamilyEvalExperiment,
} from './family-observability-output-model.js';

interface OutputRunFixture extends FamilyOutputRunSummary {
  lane: 'production' | 'comparison';
  artifacts: FamilyOutputArtifact[];
}

function artifact(
  path: string,
  overrides: Partial<FamilyOutputArtifact> = {},
): FamilyOutputArtifact {
  return {
    runId: 'parent-run',
    path,
    ...overrides,
  };
}

function run(overrides: Partial<OutputRunFixture> = {}): OutputRunFixture {
  return {
    runId: 'parent-run',
    lane: 'production',
    createdAt: '2026-05-14T12:00:00.000Z',
    artifacts: [],
    ...overrides,
  };
}

function snapshot(
  overrides: Partial<FamilyOutputSnapshot<OutputRunFixture>> = {},
): FamilyOutputSnapshot<OutputRunFixture> {
  return {
    runs: [],
    evidence: [],
    ...overrides,
  };
}

function resultPackage(overrides: Partial<ResultPackageProjection> = {}): ResultPackageProjection {
  return {
    role: 'candidate',
    packageId: 'package-123456789abc',
    packageHash: 'hash-123456789abc',
    packagePath: 'packages/package-123456789abc.tgz',
    runId: 'candidate-run',
    status: 'final',
    diff: {
      source: 'artifact',
      available: true,
      files: 2,
      additions: 12,
      deletions: 3,
      kind: 'contribution',
      artifactPath: 'artifacts/eval.diff',
    },
    visualEvidenceCount: 0,
    validationEvidenceCount: 0,
    reviewEvidenceCount: 0,
    missingData: [],
    ...overrides,
  };
}

function familyArtifact(
  path: string,
  overrides: Partial<FamilyObservabilityArtifact> = {},
): FamilyObservabilityArtifact {
  return {
    runId: 'candidate-run',
    familyId: 'family-1',
    path,
    purpose: 'eval-diff',
    source: 'task-artifact',
    ...overrides,
  };
}

function evalExperiment(overrides: Partial<EvalExperimentProjection>): EvalExperimentProjection {
  return {
    experimentId: 'exp-1',
    experimentKey: 'experiment-one',
    familyId: 'family-1',
    taskProfile: 'fix-bug',
    rubricId: 'rubric',
    rubricVersion: 'v1',
    case: {
      caseId: 'case-1',
      source: { kind: 'prior-run', runId: 'reference-run' },
      taskProfile: 'fix-bug',
      objectiveHash: 'objective-hash',
      referencePackageId: 'reference-package',
      referencePackageHash: 'reference-hash',
      referencePackagePath: 'packages/reference.tgz',
    },
    candidateStrategies: [],
    trials: [],
    missingData: [],
    manifestPath: 'evals/exp-1.json',
    ...overrides,
  };
}

test('evidenceSummary counts evidence by source run and labels media/report artifacts', () => {
  const parent = run();
  const view = snapshot({
    evidence: [
      artifact('captures/after.png', { sizeBytes: 10 }),
      artifact('captures/replay.webm', { runId: 'candidate-run', sourceRunId: 'parent-run' }),
      artifact('reports/quality-summary.md'),
    ],
  });

  assert.equal(evidenceSummary(view, parent), '3 artifacts · 1 img · 1 video · 1 docs');
  assert.equal(evidenceSummary(view, run({ runId: 'unrelated-run' })), 'no evidence');
});

test('runArtifactFootprint prefers ledger footprint, then run artifacts, then evidence', () => {
  const parent = run({
    artifacts: [artifact('artifacts/output.json', { sizeBytes: 25 })],
  });

  assert.deepEqual(
    runArtifactFootprint(
      snapshot({
        evidence: [artifact('captures/after.png', { sizeBytes: 10 })],
        familyChangeLedger: {
          entries: [{ runId: 'parent-run', artifactFootprint: { count: 7, bytes: 700 } }],
        },
      }),
      parent,
    ),
    { count: 7, bytes: 700 },
  );

  assert.deepEqual(
    runArtifactFootprint(
      snapshot({ evidence: [artifact('captures/after.png', { sizeBytes: 10 })] }),
      parent,
    ),
    { count: 1, bytes: 25 },
  );

  assert.deepEqual(
    runArtifactFootprint(
      snapshot({
        evidence: [artifact('captures/after.png', { sizeBytes: 10 }), artifact('logs/report.txt')],
      }),
      run(),
    ),
    { count: 2, bytes: 10 },
  );
});

test('outputSummaryForRun combines footprint and previewable evidence count', () => {
  const parent = run({
    artifacts: [
      artifact('artifacts/output.json', { sizeBytes: 25 }),
      artifact('artifacts/manifest.json'),
    ],
  });
  const summary = outputSummaryForRun(
    snapshot({
      evidence: [artifact('captures/after.png'), artifact('reports/quality-summary.md')],
    }),
    parent,
  );

  assert.equal(summary.run, parent);
  assert.equal(summary.artifactCount, 2);
  assert.equal(summary.artifactBytes, 25);
  assert.equal(summary.evidenceCount, 2);
});

test('findOutputComparisonPair resolves selected comparison parent or newest direct child', () => {
  const parent = run();
  const olderCandidate = run({
    runId: 'older-candidate',
    lane: 'comparison',
    parentRunId: 'parent-run',
    createdAt: '2026-05-14T12:05:00.000Z',
  });
  const newestCandidate = run({
    runId: 'newest-candidate',
    lane: 'comparison',
    parentRunId: 'parent-run',
    createdAt: '2026-05-14T12:10:00.000Z',
  });
  const view = snapshot({ runs: [parent, olderCandidate, newestCandidate] });

  assert.deepEqual(findOutputComparisonPair(view, newestCandidate), {
    baseline: parent,
    replay: newestCandidate,
  });
  assert.deepEqual(findOutputComparisonPair(view, parent), {
    baseline: parent,
    replay: newestCandidate,
  });
  assert.equal(findOutputComparisonPair(view, run({ runId: 'unrelated-run' })), null);
  assert.equal(findOutputComparisonPair(view, null), null);
});

test('resultPackageAxisLabel uses stable template runner and model fallback order', () => {
  assert.equal(
    resultPackageAxisLabel(
      resultPackage({
        axes: {
          template: {
            name: 'task-template',
            path: 'templates/fix-bug.md',
            version: 'v2',
            hash: 'template-hash',
          },
          runner: { ref: 'runner-ref', version: 'runner-v1', name: 'codex' },
          model: { version: 'gpt-fallback', name: 'gpt-4.1' },
          actualModel: { name: 'gpt-5.1' },
        },
      }),
    ),
    'template-hash · codex/gpt-5.1',
  );

  assert.equal(
    resultPackageAxisLabel(
      resultPackage({
        axes: {
          template: { path: 'templates/dev.md' },
          runner: { ref: 'runner-ref' },
          model: { version: 'gpt-4.1' },
        },
      }),
    ),
    'templates/dev.md · runner-ref/gpt-4.1',
  );

  assert.equal(resultPackageAxisLabel(resultPackage()), 'template — · runner —/model —');
});

test('resultPackageDiffLabel and artifact helper share diff availability rules', () => {
  const existing = familyArtifact('artifacts/eval.diff');
  const snapshotForDiff = {
    familyId: 'family-1',
    runs: [{ runId: 'candidate-run', artifacts: [existing] }],
  };

  const available = resultPackage();
  assert.equal(resultPackageDiffLabel(available), '2 files · +12 -3');
  assert.equal(resultPackageDiffArtifact(snapshotForDiff, available), existing);

  assert.deepEqual(
    resultPackageDiffArtifact(
      { familyId: 'family-1', runs: [{ runId: 'candidate-run', artifacts: [] }] },
      available,
    ),
    familyArtifact('artifacts/eval.diff'),
  );

  const missing = resultPackage({
    diff: {
      source: 'unavailable',
      available: false,
      files: 0,
      additions: 0,
      deletions: 0,
      kind: 'contribution',
      missingReason: 'diff unavailable',
    },
  });
  assert.equal(resultPackageDiffLabel(missing), 'diff unavailable');
  assert.equal(resultPackageDiffArtifact(snapshotForDiff, missing), null);
});

test('resultPackageEvidenceLabel summarizes validation visual and review counts', () => {
  assert.equal(
    resultPackageEvidenceLabel(
      resultPackage({
        validationEvidenceCount: 3,
        visualEvidenceCount: 2,
        reviewEvidenceCount: 1,
      }),
    ),
    '3 validation · 2 visual · 1 review',
  );
});

test('resultPackageSourceLabel formats source variants and role fallbacks', () => {
  assert.equal(
    resultPackageSourceLabel(resultPackage({ role: 'reference', source: undefined })),
    'Reference source',
  );
  assert.equal(resultPackageSourceLabel(resultPackage({ source: undefined })), 'Candidate output');
  assert.equal(
    resultPackageSourceLabel(
      resultPackage({ source: { kind: 'prior-run', runId: 'run-1234567890abcdef' } }),
    ),
    'Prior run run-1234',
  );
  assert.equal(
    resultPackageSourceLabel(
      resultPackage({ source: { kind: 'merged-pr', repo: 'owner/repo', prNumber: 42 } }),
    ),
    'owner/repo#42',
  );
  assert.equal(
    resultPackageSourceLabel(
      resultPackage({ source: { kind: 'package', packageId: 'package-123456789abc' } }),
    ),
    'Package package-1234',
  );
  assert.equal(
    resultPackageSourceLabel(
      resultPackage({ source: { kind: 'git-ref', repository: 'owner/repo', ref: 'feature/x' } }),
    ),
    'owner/repo@feature/x',
  );
  assert.equal(
    resultPackageSourceLabel(resultPackage({ source: { kind: 'git-ref', ref: 'abc123' } })),
    'abc123',
  );
});

test('selectedFamilyEvalExperiment resolves selected key or defaults to first experiment', () => {
  const first = evalExperiment({ experimentId: 'exp-1', experimentKey: 'one' });
  const second = evalExperiment({ experimentId: 'exp-2', experimentKey: 'two' });

  assert.equal(selectedFamilyEvalExperiment({ experiments: [first, second] }, 'two'), second);
  assert.equal(selectedFamilyEvalExperiment({ experiments: [first, second] }, 'missing'), first);
  assert.equal(selectedFamilyEvalExperiment({ experiments: [] }, 'missing'), null);
  assert.equal(selectedFamilyEvalExperiment({}, 'missing'), null);
});
