import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  FamilyChangeLedgerEntry,
  FamilyObservabilityArtifact,
  FamilyObservabilityRunSummary,
} from '@farmslot/protocol';

import {
  artifactFromPath,
  diffArtifactFromProvenance,
  familyContributionDeltaLabel,
  familyDiffArtifact,
  familyDiffLabel,
  type FamilyDiffSnapshot,
  familyLedgerEntry,
  ledgerDiffArtifact,
  ledgerDiffLabel,
  ledgerDiffScopeLabel,
  runDiffArtifact,
  runDiffLabel,
} from './family-observability-diff-model.js';

type DiffStat = FamilyObservabilityRunSummary['diffStat'];
type DiffProvenance = FamilyChangeLedgerEntry['contributionDiff'];
type DiffRun = Pick<FamilyObservabilityRunSummary, 'artifacts' | 'diffStat' | 'runId'>;

function diff(overrides: Partial<DiffProvenance> = {}): DiffProvenance {
  return {
    source: 'artifact',
    available: true,
    files: 2,
    additions: 10,
    deletions: 2,
    kind: 'contribution',
    artifactPath: 'artifacts/diff.txt',
    ...overrides,
  };
}

function emptyDiff(overrides: Partial<DiffProvenance> = {}): DiffProvenance {
  return diff({
    source: 'unavailable',
    available: false,
    files: 0,
    additions: 0,
    deletions: 0,
    artifactPath: undefined,
    ...overrides,
  });
}

function stat(overrides: Partial<DiffStat> = {}): DiffStat {
  return {
    available: true,
    files: 1,
    additions: 4,
    deletions: 1,
    ...overrides,
  };
}

function artifact(
  path: string,
  overrides: Partial<FamilyObservabilityArtifact> = {},
): FamilyObservabilityArtifact {
  return {
    runId: 'run-1',
    familyId: 'family-1',
    path,
    purpose: 'diff',
    source: 'task-artifact',
    ...overrides,
  };
}

function run(overrides: Partial<DiffRun> = {}): DiffRun {
  return {
    runId: 'run-1',
    diffStat: stat(),
    artifacts: [],
    ...overrides,
  };
}

function ledgerEntry(overrides: Partial<FamilyChangeLedgerEntry> = {}): FamilyChangeLedgerEntry {
  return {
    runId: 'run-1',
    familyId: 'family-1',
    familyRootTicketOrPr: 'PROJ-1',
    lane: 'production',
    flowType: 'fix-bug',
    project: 'proj',
    ticketOrPr: 'PROJ-1',
    branch: 'fix/proj-1',
    prNumber: 42,
    createdAt: '2026-05-14T12:00:00.000Z',
    changeKind: 'contribution',
    contributionDiff: diff(),
    artifactFootprint: {
      count: 0,
      bytes: 0,
      byPurpose: [],
      bySource: [],
      byExtension: [],
    },
    taskInputArtifacts: [],
    missingData: [],
    ...overrides,
  };
}

function snapshot(overrides: Partial<FamilyDiffSnapshot> = {}): FamilyDiffSnapshot {
  return {
    diffStat: stat(),
    evidence: [],
    runs: [],
    ...overrides,
  };
}

test('familyLedgerEntry finds ledger entries by run id', () => {
  const entry = ledgerEntry({ runId: 'run-2' });
  assert.equal(
    familyLedgerEntry(snapshot({ familyChangeLedger: { entries: [entry] } }), 'run-2'),
    entry,
  );
  assert.equal(
    familyLedgerEntry(snapshot({ familyChangeLedger: { entries: [entry] } }), 'run-3'),
    undefined,
  );
});

test('ledgerDiffLabel follows review input contribution input legacy fallback order', () => {
  assert.equal(
    ledgerDiffLabel(
      ledgerEntry({
        changeKind: 'review-input',
        inputDiff: diff({ additions: 8, deletions: 3 }),
        contributionDiff: diff({ additions: 10, deletions: 2 }),
      }),
    ),
    'reviewed PR input +8 -3',
  );
  assert.equal(
    ledgerDiffLabel(ledgerEntry({ contributionDiff: diff({ additions: 10, deletions: 2 }) })),
    'produced code delta +10 -2',
  );
  assert.equal(
    ledgerDiffLabel(
      ledgerEntry({
        contributionDiff: emptyDiff(),
        inputDiff: diff({ additions: 7, deletions: 1 }),
      }),
    ),
    'reviewed PR input +7 -1',
  );
  assert.equal(
    ledgerDiffLabel(
      ledgerEntry({
        contributionDiff: emptyDiff(),
        legacyDiffFallback: diff({ additions: 5, deletions: 4 }),
      }),
    ),
    'legacy diff +5 -4',
  );
  assert.equal(ledgerDiffLabel(ledgerEntry({ contributionDiff: emptyDiff() })), 'no code delta');
});

test('ledgerDiffScopeLabel distinguishes reviewed input snapshots from produced deltas', () => {
  assert.equal(
    ledgerDiffScopeLabel(
      ledgerEntry({
        changeKind: 'review-input',
        inputDiff: diff({ additions: 8, deletions: 3 }),
        contributionDiff: diff({ additions: 10, deletions: 2 }),
      }),
    ),
    'reviewed input snapshot',
  );
  assert.equal(
    ledgerDiffScopeLabel(ledgerEntry({ contributionDiff: diff({ additions: 10, deletions: 2 }) })),
    'produced code delta',
  );
  assert.equal(
    ledgerDiffScopeLabel(
      ledgerEntry({ contributionDiff: emptyDiff(), inputDiff: diff({ additions: 7 }) }),
    ),
    'reviewed input snapshot',
  );
});

test('family diff labels preserve summary display text', () => {
  assert.equal(familyDiffLabel(snapshot()), '1 files · +4 -1');
  assert.equal(familyDiffLabel(snapshot({ diffStat: stat({ available: false }) })), 'Unavailable');
  assert.equal(
    familyContributionDeltaLabel(
      snapshot({
        diffStat: stat({ available: false }),
        familyChangeLedger: {
          entries: [],
          summary: {
            totalContributionFiles: 7,
            totalContributionAdditions: 21,
            totalContributionDeletions: 5,
          },
        },
      }),
    ),
    '7 files · +21 -5',
  );
});

test('runDiffLabel uses ledger label before run diff stat fallback', () => {
  const entry = ledgerEntry({ contributionDiff: diff({ additions: 3, deletions: 1 }) });
  assert.equal(
    runDiffLabel(snapshot({ familyChangeLedger: { entries: [entry] } }), run()),
    'produced code delta +3 -1',
  );
  assert.equal(
    runDiffLabel(
      snapshot({
        familyChangeLedger: {
          entries: [
            ledgerEntry({
              changeKind: 'review-input',
              contributionDiff: diff({ additions: 11, deletions: 4 }),
              inputDiff: diff({ additions: 6, deletions: 2 }),
            }),
          ],
        },
      }),
      run(),
    ),
    'produced code delta +11 -4',
  );
  assert.equal(
    runDiffLabel(snapshot(), run({ diffStat: stat({ additions: 9, deletions: 2 }) })),
    'produced code delta +9 -2',
  );
  assert.equal(
    runDiffLabel(snapshot(), run({ diffStat: stat({ available: false }) })),
    'no code delta',
  );
});

test('artifact helpers reuse existing artifacts before synthesizing path fallbacks', () => {
  const existing = artifact('artifacts/diff.txt');
  const view = snapshot({ runs: [run({ artifacts: [existing] })], evidence: [] });

  assert.equal(
    artifactFromPath(view, 'run-1', 'family-1', 'artifacts/diff.txt', 'diff', 'task-artifact'),
    existing,
  );
  assert.deepEqual(
    artifactFromPath(view, 'run-1', 'family-1', 'artifacts/missing.diff', 'diff', 'task-artifact'),
    artifact('artifacts/missing.diff'),
  );
  assert.equal(
    artifactFromPath(view, 'run-1', 'family-1', undefined, 'diff', 'task-artifact'),
    null,
  );
  assert.equal(
    diffArtifactFromProvenance(view, 'run-1', 'family-1', emptyDiff(), 'diff', 'task-artifact'),
    null,
  );
});

test('ledgerDiffArtifact shares review input contribution input legacy fallback order', () => {
  const view = snapshot({ runs: [run()], evidence: [] });

  assert.deepEqual(
    ledgerDiffArtifact(
      view,
      ledgerEntry({
        changeKind: 'review-input',
        inputDiff: diff({ artifactPath: 'inputs/review.diff' }),
      }),
    ),
    artifact('inputs/review.diff', { purpose: 'input-diff', source: 'task-input' }),
  );
  assert.deepEqual(
    ledgerDiffArtifact(
      view,
      ledgerEntry({ contributionDiff: diff({ artifactPath: 'artifacts/code.diff' }) }),
    ),
    artifact('artifacts/code.diff'),
  );
  assert.deepEqual(
    ledgerDiffArtifact(
      view,
      ledgerEntry({
        contributionDiff: emptyDiff(),
        inputDiff: diff({ artifactPath: 'inputs/fallback.diff' }),
      }),
    ),
    artifact('inputs/fallback.diff', { purpose: 'input-diff', source: 'task-input' }),
  );
  assert.deepEqual(
    ledgerDiffArtifact(
      view,
      ledgerEntry({
        contributionDiff: emptyDiff(),
        legacyDiffFallback: diff({ artifactPath: 'legacy/diff.txt' }),
      }),
    ),
    artifact('legacy/diff.txt', { purpose: 'legacy-diff', source: 'step-output' }),
  );
});

test('runDiffArtifact prefers ledger artifact and falls back to run diff-shaped artifacts', () => {
  const ledger = ledgerEntry({ contributionDiff: diff({ artifactPath: 'ledger/diff.txt' }) });
  assert.deepEqual(
    runDiffArtifact(snapshot({ runs: [run()], familyChangeLedger: { entries: [ledger] } }), run()),
    artifact('ledger/diff.txt'),
  );

  const runArtifact = artifact('screenshots/visual.diff', { purpose: 'visual-diff' });
  assert.equal(
    runDiffArtifact(
      snapshot({ runs: [run({ artifacts: [runArtifact] })] }),
      run({ artifacts: [runArtifact] }),
    ),
    runArtifact,
  );
  assert.equal(runDiffArtifact(snapshot(), run({ diffStat: stat({ available: false }) })), null);
});

test('familyDiffArtifact selects diffStat run before ledger fallback', () => {
  const runArtifact = artifact('selected/diff.txt', { runId: 'selected-run' });
  assert.equal(
    familyDiffArtifact(
      snapshot({
        diffStat: { ...stat(), runId: 'selected-run' },
        runs: [
          run({ runId: 'other-run' }),
          run({ runId: 'selected-run', artifacts: [runArtifact] }),
        ],
      }),
    ),
    runArtifact,
  );

  assert.deepEqual(
    familyDiffArtifact(
      snapshot({
        diffStat: { ...stat({ available: false }), runId: undefined },
        runs: [],
        familyChangeLedger: {
          entries: [
            ledgerEntry({ contributionDiff: diff({ artifactPath: 'ledger/family.diff' }) }),
          ],
        },
      }),
    ),
    artifact('ledger/family.diff'),
  );
});
