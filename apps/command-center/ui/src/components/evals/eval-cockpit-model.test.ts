import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  EvalExperimentCreateResult,
  EvalExperimentManifest,
  EvalTrialStartResult,
  QueueItem,
  ResultPackageManifest,
  Run,
} from '@farmslot/protocol';

import {
  activeEvalRunCount,
  axesForCandidateRow,
  buildEvalCellQueueRequest,
  candidateLabel,
  candidateTemplateChoices,
  candidateVariant,
  capGroupIdForDataset,
  datasetIdForSelectedCases,
  defaultRows,
  manualEvalProjectOptions,
  manualEvalProjectValue,
  packageRowsForEvalCockpit,
  queuedEvalItemsForCapGroup,
  sanitizeCandidateRows,
  sanitizeSelectedCases,
  trialIdForCell,
} from './eval-cockpit-model.js';
import type { CandidateRow } from './eval-cockpit-url-state.js';
import type { EvalSelectedCase } from './eval-suite-helpers.js';

function makeCase(overrides: Partial<EvalSelectedCase> = {}): EvalSelectedCase {
  return {
    selectionId: 'selection-1',
    datasetItemId: 'case-1',
    sourceKey: 'merged-pr:owner/repo#1',
    kind: 'merged-pr',
    source: { kind: 'merged-pr', ref: 'owner/repo#1' },
    label: 'Reference PR',
    project: 'farm',
    taskProfile: 'fix-bug',
    objective: 'Fix checkout crash',
    objectiveHash: 'objective-hash',
    statusLabel: 'ready',
    sourceStatusLabel: 'merged',
    suitabilityLabel: 'ready',
    warnings: [],
    ...overrides,
  };
}

function makeRow(overrides: Partial<CandidateRow> = {}): CandidateRow {
  return {
    ...defaultRows()[0],
    id: 'candidate-a',
    runner: 'codex',
    model: 'gpt-5.5',
    ...overrides,
  };
}

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run-1',
    familyId: 'family-1',
    parentRunId: null,
    lane: 'production',
    flowType: 'fix-bug',
    status: 'monitoring',
    project: 'farm',
    ticketOrPr: 'owner/repo#1',
    slotId: null,
    branch: null,
    taskFile: null,
    steps: [],
    decisions: [],
    metrics: { nudgeCount: 0, model: 'gpt-5.5', runner: 'codex' },
    createdAt: '2026-05-09T00:00:00.000Z',
    updatedAt: '2026-05-09T00:00:00.000Z',
    ...overrides,
  } as Run;
}

function evalExperiment(capGroupId: string): NonNullable<Run['engineState']>['evalExperiment'] {
  return {
    capGroupId,
    experimentId: 'experiment-1',
    experimentKey: 'experiment-key-1',
    experimentManifestPath: '/tmp/experiment.json',
    packagePath: '/tmp/package.json',
    candidateStrategyFingerprint: 'fingerprint-1',
    trialId: 'trial-1',
  };
}

function makePackage(overrides: Partial<ResultPackageManifest> = {}): ResultPackageManifest {
  return {
    version: 1,
    kind: 'result-package',
    packageId: 'pkg-reference',
    packageHash: 'hash-reference',
    status: 'final',
    createdAt: '2026-05-14T00:00:00.000Z',
    project: 'farm',
    familyId: 'family-1',
    objectiveHash: 'objective-hash',
    taskProfile: 'fix-bug',
    source: { kind: 'merged-pr', repo: 'owner/repo', prNumber: 1 },
    role: 'reference',
    diff: {
      source: 'unavailable',
      available: false,
      files: 0,
      additions: 0,
      deletions: 0,
      kind: 'contribution',
      missingReason: 'not-loaded',
    },
    axes: {},
    visualEvidence: [],
    validationEvidence: [],
    reviewEvidence: [],
    outcomeClaims: [],
    missingData: [],
    ...overrides,
  };
}

function makeManifest(overrides: Partial<EvalExperimentManifest> = {}): EvalExperimentManifest {
  return {
    version: 1,
    kind: 'eval-experiment',
    experimentId: 'experiment-1',
    experimentKey: 'experiment-key-1',
    createdAt: '2026-05-14T00:00:00.000Z',
    updatedAt: '2026-05-14T00:00:00.000Z',
    project: 'farm',
    familyId: 'family-1',
    datasetId: 'dataset-1',
    datasetItemId: 'case-1',
    case: {
      caseId: 'case-1',
      source: { kind: 'merged-pr', repo: 'owner/repo', prNumber: 1 },
      taskProfile: 'fix-bug',
      objectiveHash: 'objective-hash',
      referencePackageId: 'pkg-reference',
      referencePackageHash: 'hash-reference',
      referencePackagePath: '/tmp/reference.json',
      label: 'Reference PR',
    },
    rubric: {
      taskProfile: 'fix-bug',
      rubricId: 'default',
      rubricVersion: '1',
      requiredEvidence: [],
    },
    candidateStrategies: [
      {
        strategyId: 'strategy-1',
        label: 'Candidate A',
        axes: { runner: { name: 'codex' }, model: { name: 'gpt-5.5' } },
        candidateStrategyFingerprint: 'fingerprint-1',
      },
    ],
    trials: [
      {
        trialId: 'trial-1',
        strategyId: 'strategy-1',
        caseId: 'case-1',
        status: 'final',
        runId: 'run-1',
        packageId: 'pkg-manifest',
        packageHash: 'hash-manifest',
        packagePath: '/tmp/manifest-package.json',
        missingData: [],
      },
    ],
    missingData: [],
    ...overrides,
  };
}

function makeEvalResult(
  overrides: Partial<EvalExperimentCreateResult> = {},
): EvalExperimentCreateResult {
  const referencePackage = makePackage();
  return {
    experimentId: 'experiment-1',
    experimentKey: 'experiment-key-1',
    familyId: 'family-1',
    experimentManifestPath: '/tmp/experiment.json',
    experimentManifest: makeManifest(),
    referencePackage,
    referencePackagePath: '/tmp/reference.json',
    ...overrides,
  };
}

function makeTrialResult(overrides: Partial<EvalTrialStartResult> = {}): EvalTrialStartResult {
  const experimentManifest = makeManifest();
  return {
    experimentId: 'experiment-1',
    experimentKey: 'experiment-key-1',
    deduped: false,
    strategyId: 'strategy-1',
    trialId: 'trial-append',
    candidateStrategyFingerprint: 'fingerprint-1',
    experimentManifestPath: '/tmp/experiment.json',
    experimentManifest,
    candidatePackage: makePackage({
      packageId: 'pkg-append',
      packageHash: 'hash-append',
      role: 'candidate',
      runId: 'run-append',
    }),
    candidatePackagePath: '/tmp/append.json',
    ...overrides,
  };
}

test('dataset and cap group helpers keep suite identity independent from candidate axes', () => {
  const first = makeCase({ datasetItemId: 'case-b' });
  const second = makeCase({ selectionId: 'selection-2', datasetItemId: 'case-a' });

  assert.equal(
    datasetIdForSelectedCases([first, second], 'fallback'),
    datasetIdForSelectedCases([second, first], 'fallback'),
  );
  assert.equal(capGroupIdForDataset('farm-abcd'), 'suite-farm-abcd');
});

test('candidate label and variant helpers derive stable strategy display data', () => {
  const selected = makeCase({ taskProfile: 'dev' });
  const row = makeRow({ templatePath: 'templates/worker/dev.md', repeat: true });
  const choices = candidateTemplateChoices('dev', []);

  assert.match(candidateLabel(row, selected, choices), /^Dev replay · Codex \/ gpt-5\.5$/);
  assert.match(candidateVariant(row, selected), /^dev-codex-gpt-5-5-repeat$/);
});

test('buildEvalCellQueueRequest keeps trial params and queue metadata in sync', () => {
  const selectedCase = makeCase();
  const row = makeRow({ label: 'Custom candidate', model: 'gpt-5.4 mini' });
  const evalResult = makeEvalResult({ experimentKey: 'experiment-fixture-key' });
  const trialId = trialIdForCell({
    datasetId: 'dataset-1',
    cellId: 'selection-1:candidate-a',
    repeat: false,
    nonce: 'ignored-for-stable-trials',
  });

  const request = buildEvalCellQueueRequest({
    selectedCase,
    row,
    primaryCase: selectedCase,
    choices: candidateTemplateChoices('fix-bug', []),
    projectFallback: 'fallback-project',
    evalResult,
    datasetId: 'dataset-1',
    capGroupId: 'suite-dataset-1',
    cellId: 'selection-1:candidate-a',
    trialId,
  });

  assert.equal(request.queueKind, 'eval-cell');
  assert.equal(request.label, 'Reference PR / Custom candidate');
  assert.equal(request.ticketOrPr, 'EVAL-EXPERIMENT-F');
  assert.equal(request.variant, request.evalCell.trialStartParams.variant);
  assert.equal(request.evalCell.candidateLabel, 'Custom candidate');
  assert.equal(request.evalCell.trialStartParams.trialId, trialId);
  assert.deepEqual(request.evalCell.trialStartParams.axes.model, { name: 'gpt-5.4 mini' });
  assert.deepEqual(request.evalCell.trialStartParams.axes.review, {
    name: 'none',
    version: 'first-pass',
  });
});

test('candidate review mode maps to replay review axes', () => {
  assert.deepEqual(axesForCandidateRow(makeRow()).harness, { name: 'recipe-harness' });
  assert.deepEqual(axesForCandidateRow(makeRow({ harnessRef: 'abc123' })).harness, {
    name: 'recipe-harness',
    ref: 'abc123',
  });
  assert.deepEqual(axesForCandidateRow(makeRow()).review, {
    name: 'none',
    version: 'first-pass',
  });
  assert.equal(axesForCandidateRow(makeRow({ reviewMode: 'default' })).review, undefined);
  assert.deepEqual(
    axesForCandidateRow(
      makeRow({
        reviewMode: 'custom',
        reviewName: 'external-self-review',
        reviewVersion: 'r2',
      }),
    ).review,
    { name: 'external-self-review', version: 'r2' },
  );
});

test('packageRowsForEvalCockpit merges reference, manifest, append, and loaded snapshots', () => {
  const evalResult = makeEvalResult();
  const appendResult = makeTrialResult();
  const snapshotPackage = makePackage({
    packageId: 'pkg-snapshot',
    packageHash: 'hash-snapshot',
    role: 'candidate',
  });

  const rows = packageRowsForEvalCockpit({
    evalResult,
    evalResultsByCase: {},
    appendResults: [appendResult],
    appendResultsOverride: [],
    snapshots: [{ packagePath: '/tmp/snapshot.json', pkg: snapshotPackage }],
    suiteCells: [
      {
        cellId: 'selection-1:candidate-a',
        caseSelectionId: 'selection-1',
        candidateId: 'candidate-a',
        caseLabel: 'Reference PR',
        candidateLabel: 'Snapshot candidate',
        status: 'final',
        deduped: false,
        packagePath: '/tmp/snapshot.json',
        trialId: 'trial-snapshot',
        validationEvidenceCount: 0,
        visualEvidenceCount: 0,
        reviewEvidenceCount: 0,
        missingData: [],
      },
    ],
  });

  assert.deepEqual(
    rows.map((row) => [row.packageId, row.label, row.rowOrigin]),
    [
      ['pkg-reference', 'Reference PR · reference', 'result'],
      ['pkg-manifest', 'Candidate A', 'manifest'],
      ['pkg-append', 'Candidate A', 'result'],
      ['pkg-snapshot', 'Snapshot candidate', 'result'],
    ],
  );
});

test('operational eval helpers filter active runs and queued items by cap group', () => {
  const runs = [
    makeRun({
      id: 'active',
      status: 'monitoring',
      engineState: { evalExperiment: evalExperiment('cap-a') },
    }),
    makeRun({
      id: 'done',
      status: 'done',
      engineState: { evalExperiment: evalExperiment('cap-a') },
    }),
    makeRun({
      id: 'other',
      status: 'monitoring',
      engineState: { evalExperiment: evalExperiment('cap-b') },
    }),
    makeRun({ id: 'plain', status: 'monitoring' }),
  ];
  const queueItems = [
    { id: 'queue-a', evalCell: { capGroupId: 'cap-a' } },
    { id: 'queue-b', evalCell: { capGroupId: 'cap-b' } },
    { id: 'queue-plain' },
  ] as QueueItem[];

  assert.equal(activeEvalRunCount(runs, 'cap-a'), 1);
  assert.deepEqual(
    queuedEvalItemsForCapGroup(queueItems, 'cap-a').map((item) => item.id),
    ['queue-a'],
  );
});

test('manual eval project helpers preserve fallback order and option sorting', () => {
  assert.equal(
    manualEvalProjectValue({
      manualProject: ' manual-farm ',
      currentProject: 'current-farm',
      catalogProjects: ['catalog-farm'],
    }),
    'manual-farm',
  );
  assert.equal(
    manualEvalProjectValue({
      manualProject: '',
      currentProject: '',
      catalogProjects: ['catalog-farm'],
    }),
    'catalog-farm',
  );
  assert.equal(
    manualEvalProjectValue({
      manualProject: '',
      currentProject: '',
      catalogProjects: [],
    }),
    'project',
  );

  assert.deepEqual(
    manualEvalProjectOptions({
      manualProjectValue: 'manual-farm',
      currentProject: ' current-farm ',
      catalogProjects: ['z-catalog', 'a-catalog', 'current-farm'],
      selectedProjects: ['selected-farm', 'a-catalog', ''],
    }),
    ['a-catalog', 'current-farm', 'manual-farm', 'selected-farm', 'z-catalog'],
  );
});

test('sanitizeCandidateRows restores valid URL rows and drops invalid labels/models', () => {
  const rows = sanitizeCandidateRows([
    {
      id: 'candidate-a',
      enabled: false,
      label: 'Replay candidate',
      runner: 'not-a-runner',
      model: 'not-a-model',
      templatePath: 'templates/worker/custom.md',
      templateHash: 'template-hash',
      promptName: 'dev',
      promptHash: 'prompt-hash',
      harnessRef: 'harness-ref',
      baseRecipePath: 'recipes/base.json',
      baseRecipeHash: 'base-hash',
      reviewMode: 'custom',
      reviewName: 'review-loop',
      reviewVersion: 'v2',
      repeat: true,
    },
    null,
  ]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'candidate-a');
  assert.equal(rows[0].enabled, false);
  assert.equal(rows[0].label, '');
  assert.equal(rows[0].runner, defaultRows()[0].runner);
  assert.equal(rows[0].model, defaultRows()[0].model);
  assert.equal(rows[0].templatePath, 'templates/worker/custom.md');
  assert.equal(rows[0].templateHash, 'template-hash');
  assert.equal(rows[0].promptName, 'dev');
  assert.equal(rows[0].reviewMode, 'custom');
  assert.equal(rows[0].reviewName, 'review-loop');
  assert.equal(rows[0].reviewVersion, 'v2');
  assert.equal(rows[0].repeat, true);
});

test('sanitizeSelectedCases keeps restorable URL cases and omits malformed entries', () => {
  const rows = sanitizeSelectedCases([
    makeCase({
      selectionId: 'selection-url',
      datasetItemId: 'case-url',
      sourceKey: 'package:/tmp/pkg.json',
      kind: 'package',
      source: { kind: 'package', packagePath: '/tmp/pkg.json' },
      taskProfile: 'dev',
      warnings: ['missing review evidence', 42] as unknown as string[],
      statusLabel: 'manual',
      sourceStatusLabel: undefined,
      runStatusLabel: 'done',
      packagePath: '/tmp/pkg.json',
    }),
    { selectionId: 'bad', source: {} },
  ]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].selectionId, 'selection-url');
  assert.equal(rows[0].kind, 'package');
  assert.deepEqual(rows[0].source, { kind: 'package', packagePath: '/tmp/pkg.json' });
  assert.equal(rows[0].taskProfile, 'dev');
  assert.deepEqual(rows[0].warnings, ['missing review evidence']);
  assert.equal(rows[0].sourceStatusLabel, 'manual');
  assert.equal(rows[0].runStatusLabel, 'done');
  assert.equal(rows[0].packagePath, '/tmp/pkg.json');
});
