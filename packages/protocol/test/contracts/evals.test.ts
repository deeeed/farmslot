import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isEvalDatasetManifest,
  isEvalExperimentManifest,
  isEvalScorerConfigRef,
  isEvalSuiteDraftManifest,
  isResultPackageManifest,
} from '../../src/contracts/index.js';

const evalDiff = {
  source: 'artifact',
  available: true,
  files: 1,
  additions: 2,
  deletions: 1,
  kind: 'contribution',
};

function validResultPackage(overrides = {}) {
  return {
    version: 1,
    kind: 'result-package',
    packageId: 'pkg-1',
    packageHash: 'hash-1',
    status: 'final',
    createdAt: '2026-05-09T00:00:00.000Z',
    finalizedAt: '2026-05-09T00:00:01.000Z',
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
    role: 'reference',
    diff: evalDiff,
    axes: { template: { path: 'templates/fix-bug.md', hash: 'template-hash' } },
    visualEvidence: [
      {
        role: 'eval-after',
        source: 'eval-run',
        sourceRunId: 'run-1',
        artifact: {
          runId: 'run-1',
          familyId: 'family-1',
          path: 'artifacts/after.png',
          purpose: 'screenshot',
          source: 'task-artifact',
        },
      },
    ],
    validationEvidence: [
      {
        runId: 'run-1',
        familyId: 'family-1',
        path: 'artifacts/report.md',
        purpose: 'report',
        source: 'task-artifact',
      },
    ],
    reviewEvidence: [],
    outcomeClaims: [],
    missingData: [],
    ...overrides,
  };
}

test('isResultPackageManifest accepts package kernel manifests', () => {
  assert.equal(isResultPackageManifest(validResultPackage()), true);
  assert.equal(
    isResultPackageManifest(
      validResultPackage({
        axes: {
          template: { path: 'templates/fix-bug.md', hash: 'template-hash' },
          review: { name: 'none', version: 'first-pass' },
        },
      }),
    ),
    true,
  );
  assert.equal(
    isResultPackageManifest(
      validResultPackage({
        axes: { template: { path: '/private/machine/fix-bug.md' } },
      }),
    ),
    false,
  );
  assert.equal(
    isResultPackageManifest(
      validResultPackage({
        templateProvenance: {
          kind: 'task-template',
          flowType: 'fix-bug',
          project: 'example-mobile-farm',
          role: 'eval-candidate',
          templatePath: '/private/machine/fix-bug.md',
          templateName: 'fix-bug.md',
          contentHash: 'abc123',
          projectRepoPath: '/private/machine',
          source: 'current-project',
          renderedAt: '2026-05-09T00:00:00.000Z',
        },
      }),
    ),
    false,
  );
  assert.equal(
    isResultPackageManifest(validResultPackage({ status: 'draft', finalizedAt: undefined })),
    true,
  );
  assert.equal(
    isResultPackageManifest(
      validResultPackage({
        templateProvenance: {
          kind: 'task-template',
          flowType: 'fix-bug',
          taskProfile: 'fix-bug',
          project: 'example-mobile-farm',
          role: 'eval-candidate',
          templatePath: 'templates/worker/fix-bug.md',
          templateName: 'fix-bug.md',
          contentHash: 'abc123',
          executionTemplate: {
            id: 'fix-bug/autonomous.mobile',
            sourceId: 'package:canonical',
            flow: 'fix-bug',
            runMode: 'autonomous',
            platforms: ['mobile'],
            labels: ['runtime-proof'],
            relativePath: 'fix-bug/autonomous.mobile.md',
            sourceRevision: 'a'.repeat(40),
            sha256: 'b'.repeat(64),
            renderedSha256: 'c'.repeat(64),
          },
          source: 'current-project',
          renderedAt: '2026-05-09T00:00:00.000Z',
        },
      }),
    ),
    true,
  );
  assert.equal(
    isResultPackageManifest(
      validResultPackage({
        templateProvenance: {
          kind: 'task-template',
          flowType: 'fix-bug',
          project: 'example-mobile-farm',
          role: 'eval-candidate',
          templatePath: 'templates/worker/fix-bug.md',
          templateName: 'fix-bug.md',
          contentHash: 'abc123',
          executionTemplate: {
            id: 'fix-bug/mobile',
            sourceId: 'package:canonical',
            flow: 'fix-bug',
            platforms: ['mobile'],
            labels: [],
            relativePath: '/private/machine/fix-bug/mobile.md',
            sha256: 'b'.repeat(64),
          },
          source: 'current-project',
          renderedAt: '2026-05-09T00:00:00.000Z',
        },
      }),
    ),
    false,
  );
});

test('isResultPackageManifest rejects malformed hashes and evidence', () => {
  assert.equal(isResultPackageManifest(validResultPackage({ packageHash: 123 })), false);
  assert.equal(isResultPackageManifest(validResultPackage({ taskProfile: 'review-pr' })), false);
  assert.equal(
    isResultPackageManifest(
      validResultPackage({ validationEvidence: [{ path: 'artifacts/report.md' }] }),
    ),
    false,
  );
  assert.equal(
    isResultPackageManifest(
      validResultPackage({
        visualEvidence: [
          {
            role: 'bad',
            source: 'eval-run',
            artifact: { path: 'artifacts/after.png', purpose: 'screenshot' },
          },
        ],
      }),
    ),
    false,
  );
  assert.equal(
    isResultPackageManifest(validResultPackage({ status: 'final', finalizedAt: undefined })),
    false,
  );
  assert.equal(
    isResultPackageManifest(
      validResultPackage({ templateProvenance: { kind: 'task-template', contentHash: 'abc123' } }),
    ),
    false,
  );
  assert.equal(
    isResultPackageManifest(
      validResultPackage({
        axes: {
          template: { path: 'templates/fix-bug.md', hash: 'template-hash' },
          review: { name: 123 },
        },
      }),
    ),
    false,
  );
});

test('isEvalExperimentManifest accepts experiment cases, strategies, and trials', () => {
  const base = {
    version: 1,
    kind: 'eval-experiment',
    experimentId: 'experiment-1',
    experimentKey: 'experiment-key-1',
    createdAt: '2026-05-09T00:00:00.000Z',
    updatedAt: '2026-05-09T00:00:01.000Z',
    project: 'example-mobile-farm',
    familyId: 'family-1',
    case: {
      caseId: 'case-1',
      source: {
        kind: 'merged-pr',
        repo: 'owner/repo',
        prNumber: 123,
        mergedAt: '2026-05-08T00:00:00.000Z',
        headSha: 'abc123',
      },
      taskProfile: 'fix-bug',
      objectiveHash: 'objective-1',
      referencePackageId: 'pkg-1',
      referencePackageHash: 'hash-1',
      referencePackagePath: '/tmp/reference.result-package.json',
    },
    rubric: {
      taskProfile: 'fix-bug',
      rubricId: 'eval-default',
      rubricVersion: '1',
      requiredEvidence: [{ id: 'diff', label: 'Diff', state: 'missing' }],
    },
    candidateStrategies: [
      {
        strategyId: 'strategy-1',
        label: 'candidate',
        candidateStrategyFingerprint: 'axis-1',
        axes: { template: { path: 'templates/fix-bug.md' } },
      },
    ],
    trials: [
      {
        trialId: 'trial-1',
        strategyId: 'strategy-1',
        caseId: 'case-1',
        status: 'running',
        packageId: 'pkg-candidate',
        packageHash: 'hash-candidate',
        packagePath: '/tmp/candidate.result-package.json',
        missingData: [],
      },
    ],
    missingData: [],
  };
  assert.equal(isEvalExperimentManifest(base), true);
  assert.equal(isEvalExperimentManifest({ ...base, kind: 'old-eval' }), false);
  assert.equal(
    isEvalExperimentManifest({ ...base, case: { ...base.case, referencePackagePath: undefined } }),
    false,
  );
  assert.equal(
    isEvalExperimentManifest({
      ...base,
      trials: [{ ...base.trials[0], strategyId: 'missing-strategy' }],
    }),
    false,
  );
  assert.equal(
    isEvalExperimentManifest({ ...base, rubric: { ...base.rubric, taskProfile: 'dev' } }),
    false,
  );
});

function validEvalDataset(overrides = {}) {
  return {
    version: 1,
    kind: 'eval-dataset',
    datasetId: 'template-regression-smoke',
    createdAt: '2026-05-09T00:00:00.000Z',
    updatedAt: '2026-05-09T00:00:01.000Z',
    project: 'example-mobile-farm',
    label: 'Template regression smoke',
    description: 'A small catalog of reusable cases for template checks.',
    items: [
      {
        datasetItemId: 'bugfix-pr-123',
        label: 'Bugfix PR 123',
        source: {
          kind: 'merged-pr',
          repo: 'owner/repo',
          prNumber: 123,
          mergedAt: '2026-05-08T00:00:00.000Z',
        },
        taskProfile: 'fix-bug',
        objective: 'Recreate the merged bugfix.',
        objectiveHash: 'objective-1',
        metadata: { split: 'smoke', priority: 1, quarantined: false, note: null },
      },
    ],
    metadata: { owner: 'evals' },
    ...overrides,
  };
}

function validScorerConfigRef(overrides = {}) {
  return {
    scorerId: 'manual-regression-review',
    label: 'Manual regression review',
    kind: 'human',
    configRef: 'docs/evals/manual-regression.md',
    rubricId: 'eval-default',
    rubricVersion: '1',
    metadata: { owner: 'evals', blocking: false },
    ...overrides,
  };
}

function validSuiteDraft(overrides = {}) {
  return {
    version: 1,
    kind: 'eval-suite-draft',
    suiteId: 'suite-template-regression-smoke',
    suiteKey: 'template-regression-smoke-v1',
    createdAt: '2026-05-09T00:00:00.000Z',
    updatedAt: '2026-05-09T00:00:01.000Z',
    project: 'example-mobile-farm',
    label: 'Template regression smoke draft',
    description: 'Planning envelope only; does not execute suites.',
    datasetId: 'template-regression-smoke',
    datasetItemIds: ['bugfix-pr-123'],
    candidateStrategies: [
      {
        strategyId: 'current-template',
        label: 'Current template',
        axes: { template: { path: 'templates/worker/fix-bug.md', hash: 'template-current' } },
        candidateStrategyFingerprint: 'axis-current',
        metadata: { role: 'control' },
      },
    ],
    scorerConfigRefs: [validScorerConfigRef()],
    metadata: { purpose: 'template-regression' },
    ...overrides,
  };
}

test('isEvalDatasetManifest accepts dataset catalog manifests', () => {
  assert.equal(isEvalDatasetManifest(validEvalDataset()), true);
  assert.equal(
    isEvalDatasetManifest(validEvalDataset({ description: undefined, metadata: undefined })),
    true,
  );
});

test('isEvalDatasetManifest rejects malformed dataset manifests', () => {
  const [datasetItem] = validEvalDataset().items;

  assert.equal(isEvalDatasetManifest(validEvalDataset({ kind: 'eval-suite-draft' })), false);
  assert.equal(isEvalDatasetManifest(validEvalDataset({ datasetId: '' })), false);
  assert.equal(isEvalDatasetManifest(validEvalDataset({ items: undefined })), false);
  assert.equal(
    isEvalDatasetManifest(
      validEvalDataset({ items: [{ ...datasetItem, source: { kind: 'unknown' } }] }),
    ),
    false,
  );
  assert.equal(
    isEvalDatasetManifest(
      validEvalDataset({ items: [{ ...datasetItem, taskProfile: 'review-pr' }] }),
    ),
    false,
  );
});

test('isEvalScorerConfigRef accepts refs and rejects score/report/export payloads', () => {
  assert.equal(isEvalScorerConfigRef(validScorerConfigRef()), true);
  assert.equal(isEvalScorerConfigRef(validScorerConfigRef({ value: 1 })), false);
  assert.equal(isEvalScorerConfigRef(validScorerConfigRef({ score: 1 })), false);
  assert.equal(isEvalScorerConfigRef(validScorerConfigRef({ verdict: 'improved' })), false);
  assert.equal(
    isEvalScorerConfigRef(validScorerConfigRef({ reportPath: 'reports/suite.md' })),
    false,
  );
  assert.equal(
    isEvalScorerConfigRef(validScorerConfigRef({ exportPath: 'exports/langsmith.json' })),
    false,
  );
  assert.equal(
    isEvalScorerConfigRef(validScorerConfigRef({ metadata: { owner: 'evals', score: 1 } })),
    false,
  );
});

test('isEvalSuiteDraftManifest accepts suite drafts and rejects runtime-shaped fields', () => {
  const [candidateStrategy] = validSuiteDraft().candidateStrategies;

  assert.equal(isEvalSuiteDraftManifest(validSuiteDraft()), true);
  assert.equal(isEvalSuiteDraftManifest(validSuiteDraft({ kind: 'eval-suite' })), false);
  assert.equal(isEvalSuiteDraftManifest(validSuiteDraft({ suiteId: '' })), false);
  assert.equal(isEvalSuiteDraftManifest(validSuiteDraft({ score: 1 })), false);
  assert.equal(
    isEvalSuiteDraftManifest(validSuiteDraft({ reportPath: 'reports/suite.md' })),
    false,
  );
  assert.equal(
    isEvalSuiteDraftManifest(validSuiteDraft({ exportPath: 'exports/langfuse.json' })),
    false,
  );
  assert.equal(isEvalSuiteDraftManifest(validSuiteDraft({ metadata: { score: 1 } })), false);
  assert.equal(
    isEvalSuiteDraftManifest(validSuiteDraft({ datasetItemIds: ['bugfix-pr-123', ''] })),
    false,
  );
  assert.equal(
    isEvalSuiteDraftManifest(
      validSuiteDraft({ candidateStrategies: [{ strategyId: '', label: 'missing strategy id' }] }),
    ),
    false,
  );
  assert.equal(
    isEvalSuiteDraftManifest(
      validSuiteDraft({ candidateStrategies: [{ ...candidateStrategy, score: 1 }] }),
    ),
    false,
  );
  assert.equal(
    isEvalSuiteDraftManifest(
      validSuiteDraft({ candidateStrategies: [{ ...candidateStrategy, metadata: { score: 1 } }] }),
    ),
    false,
  );
  assert.equal(
    isEvalSuiteDraftManifest(
      validSuiteDraft({
        candidateStrategies: [
          {
            ...candidateStrategy,
            axes: { template: { path: 'templates/worker/fix-bug.md', score: 1 } },
          },
        ],
      }),
    ),
    false,
  );
  assert.equal(
    isEvalSuiteDraftManifest(
      validSuiteDraft({ candidateStrategies: [{ ...candidateStrategy, result: { score: 1 } }] }),
    ),
    false,
  );
  assert.equal(
    isEvalSuiteDraftManifest(
      validSuiteDraft({ scorerConfigRefs: [{ ...validScorerConfigRef(), passed: true }] }),
    ),
    false,
  );
  assert.equal(
    isEvalSuiteDraftManifest(
      validSuiteDraft({
        scorerConfigRefs: [
          { ...validScorerConfigRef(), metadata: { exportPath: 'exports/langfuse.json' } },
        ],
      }),
    ),
    false,
  );
  assert.equal(
    isEvalSuiteDraftManifest(
      validSuiteDraft({ scorerConfigRefs: [{ ...validScorerConfigRef(), result: { score: 1 } }] }),
    ),
    false,
  );
});

test('isResultPackageManifest accepts template provenance version fields from task writer', () => {
  assert.equal(
    isResultPackageManifest(
      validResultPackage({
        templateProvenance: {
          kind: 'task-template',
          flowType: 'fix-bug',
          taskProfile: 'fix-bug',
          project: 'example-mobile-farm',
          role: 'eval-candidate',
          templatePath: 'templates/worker/fix-bug-v2.md',
          templateName: 'fix-bug-v2.md',
          templateVariant: 'v2',
          templateIsDefault: false,
          contentHash: 'abc123',
          source: 'current-project',
          renderedAt: '2026-05-09T00:00:00.000Z',
        },
      }),
    ),
    true,
  );
  assert.equal(
    isResultPackageManifest(
      validResultPackage({
        templateProvenance: {
          kind: 'task-template',
          flowType: 'fix-bug',
          taskProfile: 'fix-bug',
          project: 'example-mobile-farm',
          role: 'eval-candidate',
          templatePath: 'templates/worker/fix-bug.md',
          templateName: 'fix-bug.md',
          templateVariant: null,
          templateIsDefault: true,
          contentHash: 'abc123',
          source: 'current-project',
          renderedAt: '2026-05-09T00:00:00.000Z',
        },
      }),
    ),
    true,
  );
});
