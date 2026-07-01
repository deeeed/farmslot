import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  FamilyObservabilityArtifact,
  FamilyObservabilityRunSummary,
  FamilyObservabilitySnapshot,
} from '@farmslot/protocol';

import {
  familyLightboxItemsForArtifacts,
  familyLightboxPairForArtifact,
  familyLightboxPairsForSnapshot,
  familyRunForArtifact,
  familyVisibleLightboxArtifacts,
  selectedFamilyRun,
} from './family-observability-lightbox-model.js';

function run(
  overrides: Partial<FamilyObservabilityRunSummary> = {},
): FamilyObservabilityRunSummary {
  return {
    runId: 'run-after',
    familyId: 'family-1',
    parentRunId: null,
    lane: 'production',
    flowType: 'fix-bug',
    ticketOrPr: 'DEMO-1',
    status: 'done',
    branch: 'fix/demo',
    slotId: 'slot-1',
    createdAt: '2026-05-14T12:00:00.000Z',
    updatedAt: '2026-05-14T12:05:00.000Z',
    ...overrides,
  } as FamilyObservabilityRunSummary;
}

function artifact(
  path: string,
  purpose: string,
  overrides: Partial<FamilyObservabilityArtifact> = {},
): FamilyObservabilityArtifact {
  return {
    runId: 'run-after',
    familyId: 'family-1',
    path,
    purpose,
    source: 'task-artifact',
    sizeBytes: 1024,
    ...overrides,
  } as FamilyObservabilityArtifact;
}

function snapshot(
  overrides: Partial<FamilyObservabilitySnapshot> = {},
): FamilyObservabilitySnapshot {
  return {
    familyId: 'family-1',
    latestRunId: 'run-after',
    rootTicketOrPr: 'DEMO-1',
    runs: [run()],
    evidence: [],
    relatedFamilies: [],
    artifactBuckets: [],
    changeLedger: [],
    ...overrides,
  } as FamilyObservabilitySnapshot;
}

test('selectedFamilyRun prefers explicit selection and falls back to first run', () => {
  const first = run({ runId: 'run-first' });
  const selected = run({ runId: 'run-selected' });
  const snap = snapshot({ runs: [first, selected] });

  assert.equal(selectedFamilyRun(snap, 'run-selected')?.runId, 'run-selected');
  assert.equal(selectedFamilyRun(snap, 'missing')?.runId, 'run-first');
  assert.equal(selectedFamilyRun(null, 'run-selected'), null);
});

test('familyRunForArtifact resolves source run before artifact display run', () => {
  const source = run({ runId: 'run-source', branch: 'main' });
  const replay = run({ runId: 'run-replay', branch: 'fix/replay' });
  const snap = snapshot({ runs: [source, replay] });

  assert.equal(
    familyRunForArtifact(
      snap,
      artifact('after.png', 'after', { runId: 'run-replay', sourceRunId: 'run-source' }),
    )?.runId,
    'run-source',
  );
  assert.equal(
    familyRunForArtifact(snap, artifact('after.png', 'after', { runId: 'run-replay' }))?.runId,
    'run-replay',
  );
});

test('family visible lightbox artifacts preserve override and evidence fallback order', () => {
  const evidence = [artifact('evidence-a.png', 'after'), artifact('evidence-b.png', 'after')];
  const override = [artifact('step-a.png', 'after')];

  assert.deepEqual(
    familyVisibleLightboxArtifacts(override, evidence).map((item) => item.path),
    ['step-a.png'],
  );
  assert.deepEqual(
    familyVisibleLightboxArtifacts(null, evidence).map((item) => item.path),
    ['evidence-a.png', 'evidence-b.png'],
  );
});

test('family lightbox item and pair derivation keeps run provenance and compare lookup', () => {
  const snap = snapshot({
    runs: [run({ runId: 'run-after', branch: 'fix/demo' })],
    evidence: [
      artifact('captures/before-login.png', 'before'),
      artifact('captures/after-login.png', 'after'),
    ],
  });
  const items = familyLightboxItemsForArtifacts(snap.evidence, snap);
  const pairs = familyLightboxPairsForSnapshot(snap);

  assert.equal(items[1].path, 'captures/after-login.png');
  assert.equal(items[1].provenance, 'fix @ fix/demo');
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].stem, 'login');
  assert.deepEqual(familyLightboxPairForArtifact(pairs, snap.evidence[1]), { index: 0 });
  assert.equal(familyLightboxPairForArtifact(pairs, artifact('other.png', 'after')), null);
});
