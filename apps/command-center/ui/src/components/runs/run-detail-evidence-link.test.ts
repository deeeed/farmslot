import assert from 'node:assert/strict';
import test from 'node:test';

import type { FamilyObservabilityArtifact } from '@farmslot/protocol';

import { acceptanceEvidenceRows } from '../progress-tracker/acceptance-panel.js';

import {
  acceptanceEvidenceSelection,
  resolveEvidenceLightboxLink,
  RUN_OUTPUT_SCOPE,
  runOutputEvidenceSelection,
} from './run-detail-model.js';
import {
  artifactSelectionFromRunDetailHash,
  runDetailEvidenceArtifactHash,
} from './run-detail-url-state.js';

const listed: FamilyObservabilityArtifact = {
  runId: 'run-1',
  familyId: 'family-1',
  stepName: 'monitor',
  path: 'artifacts/recipe-run/evidence-ac1-a.png',
  purpose: 'screenshot',
  source: 'artifact-manifest',
};
const other: FamilyObservabilityArtifact = { ...listed, path: 'artifacts/report.md' };
const runArtifacts = [other, listed];
const artifactUrl = (artifact: FamilyObservabilityArtifact) => `/a/${artifact.path}`;

// AC-1's second file is a ledger path the run's artifact list does not carry.
const rows = acceptanceEvidenceRows(
  { schemaVersion: 1, criteria: [] },
  [
    { id: 'AC-1', text: 'Every order type places an order' },
    { id: 'AC-2', text: 'Slippage shows before submit' },
  ],
  [{ id: 'AC-1', evidence: [listed.path, 'artifacts/recipe-run/teardown-final-state.png'] }],
).map(({ view, evidence }) => ({ id: view.id, text: view.text, evidence }));

/** Open from the AC row, write the URL, then resolve that URL as a reload would. */
function reload(index: number) {
  const opened = acceptanceEvidenceSelection({
    runId: 'run-1',
    familyId: 'family-1',
    criterion: rows[0],
    evidence: rows[0].evidence,
    index,
    runArtifacts,
    artifactUrl,
  });
  const hash = runDetailEvidenceArtifactHash(
    'run-1',
    opened.items[opened.index],
    '#run/run-1',
    opened.criterionId,
  );
  const { artifact, artifactAc } = artifactSelectionFromRunDetailHash(hash);
  const restored = resolveEvidenceLightboxLink({
    path: artifact ?? '',
    criterionId: artifactAc,
    acceptanceRows: rows,
    runId: 'run-1',
    familyId: 'family-1',
    runArtifacts,
    artifactUrl,
    progress: { loaded: true, runActive: false },
  });
  return { opened, restored };
}

test('an AC evidence link reopens the same criterion set at the same file after a reload', () => {
  for (const index of [0, 1]) {
    const { opened, restored } = reload(index);
    assert.equal(opened.scope, 'AC-1 evidence');
    assert.deepEqual(restored, opened, `file ${index}`);
  }
  const outside = reload(1).restored;
  assert.ok(
    !('unavailable' in outside),
    'a ledger path outside the run artifact list still resolves',
  );
  assert.equal(outside.items[1]?.path, 'artifacts/recipe-run/teardown-final-state.png');
});

test('a plain artifact link and the Evidence tab open the run output, never a criterion scope', () => {
  const plain = resolveEvidenceLightboxLink({
    path: listed.path,
    criterionId: null,
    acceptanceRows: rows,
    runId: 'run-1',
    familyId: 'family-1',
    runArtifacts,
    artifactUrl,
    progress: { loaded: true, runActive: false },
  });
  assert.ok(!('unavailable' in plain));
  assert.equal(plain.scope, RUN_OUTPUT_SCOPE);
  assert.equal(plain.criterionId, null);
  assert.equal(plain.index, 1);
  assert.equal(plain.items.length, 2);

  const tab = runOutputEvidenceSelection(runArtifacts, 0, artifactUrl);
  assert.equal(tab.scope, RUN_OUTPUT_SCOPE);
  assert.equal(tab.criterionId, null);
});

test('a criterion that no longer lists the file falls back to the run artifacts', () => {
  const stale = resolveEvidenceLightboxLink({
    path: listed.path,
    criterionId: 'AC-2',
    acceptanceRows: rows,
    runId: 'run-1',
    familyId: 'family-1',
    runArtifacts,
    artifactUrl,
    progress: { loaded: true, runActive: false },
  });
  assert.ok(!('unavailable' in stale));
  assert.equal(stale.scope, RUN_OUTPUT_SCOPE);

  const gone = resolveEvidenceLightboxLink({
    path: 'artifacts/recipe-run/teardown-final-state.png',
    criterionId: 'AC-2',
    acceptanceRows: rows,
    runId: 'run-1',
    familyId: 'family-1',
    runArtifacts,
    artifactUrl,
    progress: { loaded: true, runActive: false },
  });
  assert.ok('unavailable' in gone);
});
