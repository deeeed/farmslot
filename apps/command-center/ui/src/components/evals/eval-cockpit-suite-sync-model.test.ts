import assert from 'node:assert/strict';
import test from 'node:test';

import type { ResultPackageManifest, Run } from '@farmslot/protocol';

import {
  applyEvalPackageToLaunchCells,
  evalRunMatchesLaunchCell,
  evalRunStatusForLaunchCell,
  syncEvalSuiteCellsFromRuns,
} from './eval-cockpit-suite-sync-model.js';
import type { EvalLaunchCell } from './eval-suite-launch-model.js';

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: overrides.id ?? 'run-1',
    familyId: overrides.familyId ?? 'family-1',
    parentRunId: overrides.parentRunId ?? null,
    familyRootTicketOrPr: overrides.familyRootTicketOrPr ?? 'owner/repo#1',
    lane: overrides.lane ?? 'production',
    variant: overrides.variant ?? null,
    flowType: overrides.flowType ?? 'fix-bug',
    mode: overrides.mode ?? 'autonomous',
    status: overrides.status ?? 'monitoring',
    project: overrides.project ?? 'farm',
    ticketOrPr: overrides.ticketOrPr ?? 'owner/repo#1',
    slotId: overrides.slotId ?? null,
    branch: overrides.branch ?? null,
    taskFile: overrides.taskFile ?? null,
    steps: overrides.steps ?? [],
    decisions: overrides.decisions ?? [],
    metrics: overrides.metrics ?? { nudgeCount: 0, model: 'gpt-5.5', runner: 'codex' },
    createdAt: overrides.createdAt ?? '2026-05-09T00:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-05-09T00:00:00.000Z',
    ...overrides,
  } as Run;
}

function makeEvalRun(overrides: Partial<Run> = {}): Run {
  return makeRun({
    engineState: {
      evalExperiment: {
        experimentId: 'experiment-1',
        experimentKey: 'experiment-key-1',
        experimentManifestPath: '/tmp/experiment.json',
        candidateStrategyFingerprint: 'fingerprint-1',
        trialId: 'trial-1',
        packagePath: '/tmp/package-1.json',
      },
    },
    ...overrides,
  });
}

function makeCell(overrides: Partial<EvalLaunchCell> = {}): EvalLaunchCell {
  return {
    cellId: 'selection-1:candidate-a',
    caseSelectionId: 'selection-1',
    candidateId: 'candidate-a',
    caseLabel: 'Reference PR',
    candidateLabel: 'Candidate A',
    status: 'queued',
    deduped: false,
    trialId: 'trial-1',
    validationEvidenceCount: 0,
    visualEvidenceCount: 0,
    reviewEvidenceCount: 0,
    missingData: [],
    ...overrides,
  };
}

function makeArtifact(
  overrides: Partial<ResultPackageManifest['validationEvidence'][number]> = {},
) {
  return {
    runId: 'run-1',
    familyId: 'family-1',
    path: '/tmp/artifact.log',
    purpose: 'validation',
    source: 'artifact-manifest' as const,
    ...overrides,
  };
}

function makePackage(overrides: Partial<ResultPackageManifest> = {}): ResultPackageManifest {
  return {
    version: 1,
    kind: 'result-package',
    packageId: 'pkg-1',
    packageHash: 'hash-1',
    status: 'final',
    createdAt: '2026-05-14T00:00:00.000Z',
    project: 'farm',
    familyId: 'family-1',
    objectiveHash: 'objective-hash',
    taskProfile: 'fix-bug',
    source: { kind: 'merged-pr', repo: 'owner/repo', prNumber: 1 },
    role: 'candidate',
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
    metrics: { durationMs: 1234, costEstimate: 0.42 },
    visualEvidence: [
      {
        role: 'eval-after',
        label: 'screenshot',
        source: 'eval-run',
        artifact: makeArtifact({ path: '/tmp/screenshot.png', purpose: 'screenshot' }),
      },
    ],
    validationEvidence: [
      makeArtifact({ path: '/tmp/typecheck.log', purpose: 'typecheck' }),
      makeArtifact({ path: '/tmp/lint.log', purpose: 'lint' }),
    ],
    reviewEvidence: [makeArtifact({ path: '/tmp/review.md', purpose: 'review' })],
    outcomeClaims: [],
    missingData: ['diff'],
    ...overrides,
  };
}

test('eval run matcher accepts trial ids, explicit run ids, and rejects non-eval runs', () => {
  const run = makeEvalRun({ id: 'run-a' });

  assert.equal(evalRunMatchesLaunchCell(run, makeCell({ trialId: 'trial-1' })), true);
  assert.equal(
    evalRunMatchesLaunchCell(run, makeCell({ runId: 'run-a', trialId: 'different-trial' })),
    true,
  );
  assert.equal(evalRunMatchesLaunchCell(makeRun({ id: 'plain-run' }), makeCell()), false);
});

test('run status for launch cells preserves failed, final, and running precedence', () => {
  assert.equal(evalRunStatusForLaunchCell(makeEvalRun({ status: 'failed' })), 'failed');
  assert.equal(evalRunStatusForLaunchCell(makeEvalRun({ status: 'done' })), 'final');
  assert.equal(
    evalRunStatusForLaunchCell(makeEvalRun({ status: 'monitoring' }), makePackage()),
    'final',
  );
  assert.equal(
    evalRunStatusForLaunchCell(
      makeEvalRun({ status: 'monitoring' }),
      makePackage({ status: 'draft' }),
    ),
    'running',
  );
});

test('applyEvalPackageToLaunchCells patches only cells matched by the run', () => {
  const matching = makeCell({ cellId: 'match', trialId: 'trial-1' });
  const unmatched = makeCell({ cellId: 'miss', trialId: 'trial-2', missingData: ['existing'] });
  const patched = applyEvalPackageToLaunchCells(
    [matching, unmatched],
    makeEvalRun({ id: 'run-a' }),
    makePackage(),
    '/tmp/package-1.json',
  );

  assert.equal(patched[0].status, 'final');
  assert.equal(patched[0].runId, 'run-a');
  assert.equal(patched[0].packagePath, '/tmp/package-1.json');
  assert.equal(patched[0].packageId, 'pkg-1');
  assert.equal(patched[0].validationEvidenceCount, 2);
  assert.equal(patched[0].visualEvidenceCount, 1);
  assert.equal(patched[0].reviewEvidenceCount, 1);
  assert.deepEqual(patched[0].missingData, ['diff']);
  assert.deepEqual(patched[1], unmatched);
});

test('syncEvalSuiteCellsFromRuns hydrates cached package cells and reports matching runs to load', () => {
  const matchingRun = makeEvalRun({ id: 'run-a', status: 'monitoring' });
  const unrelatedRun = makeEvalRun({
    id: 'run-b',
    engineState: {
      evalExperiment: {
        experimentId: 'experiment-9',
        experimentKey: 'experiment-key-9',
        experimentManifestPath: '/tmp/experiment-9.json',
        candidateStrategyFingerprint: 'fingerprint-9',
        trialId: 'trial-9',
        packagePath: '/tmp/package-9.json',
      },
    },
  });
  const unchanged = makeCell({
    cellId: 'unchanged',
    trialId: 'trial-2',
    packagePath: '/tmp/existing.json',
  });
  const pkg = makePackage({ packageId: 'cached-pkg' });

  const result = syncEvalSuiteCellsFromRuns({
    cells: [makeCell({ cellId: 'matched' }), unchanged],
    runs: [matchingRun, unrelatedRun],
    packageSnapshots: new Map([
      ['/tmp/package-1.json', { revision: 'rev-1', pkg, packagePath: '/tmp/package-1.json' }],
    ]),
  });

  assert.equal(result.cells[0].status, 'final');
  assert.equal(result.cells[0].runId, 'run-a');
  assert.equal(result.cells[0].packagePath, '/tmp/package-1.json');
  assert.equal(result.cells[0].packageId, 'cached-pkg');
  assert.equal(result.cells[0].durationMs, 1234);
  assert.deepEqual(result.cells[1], unchanged);
  assert.deepEqual(
    result.packageRunsToLoad.map((run) => run.id),
    ['run-a'],
  );
});
