import assert from 'node:assert/strict';
import test from 'node:test';

import { createEvidenceReviewModel } from '@farmslot/adapter-sdk/evidence';
import type { AcceptanceStatusLedger, RecordedEvidencePackageInput } from '@farmslot/protocol';

import { acceptancePanelPresentation } from '../src/run-results.js';

test('the AC tally does not count a replaced recording as current proof', () => {
  const criterion = (verdict: 'proven' | 'awaiting-review') => ({
    id: 'AC-1',
    text: 'The panel lists every criterion',
    kind: 'acceptance' as const,
    verdict,
    proofMode: 'mixed' as const,
    evidence: ['artifacts/recipe-runs/20261101082718242-33108/trace.json'],
    recipeNodes: [],
    assertionIndices: [],
    moments: [],
  });
  const packageClaims = {
    schemaVersion: 2 as const,
    recipeRunId: 'gate-attempt',
    criteria: [criterion('proven')],
    recording: { status: 'complete' as const, segments: [] },
  };
  const ledger = (recipeRunId: string): AcceptanceStatusLedger => ({
    schemaVersion: 2,
    recipeRunId,
    criteria: [criterion('proven')],
  });
  const gatePackage: RecordedEvidencePackageInput = {
    claims: packageClaims,
    summary: {},
    artifactDigests: {},
    timelines: {},
  };
  const model = (recipeRunId: string) =>
    createEvidenceReviewModel({
      package: gatePackage,
      packagePath: 'recipe-runs/20261101072653297-84101',
      ledger: ledger(recipeRunId),
    });
  const replaced = acceptancePanelPresentation(
    ledger('newer-attempt'),
    undefined,
    model('newer-attempt'),
  );
  assert.equal(replaced.counts, '1 criteria · evidence replaced');
  // The tooltip and the accessibility label read the same, never the replaced buckets.
  assert.equal(replaced.countsTooltip, 'evidence replaced · 1 criteria');
  assert.equal(
    acceptancePanelPresentation(ledger('gate-attempt'), undefined, model('gate-attempt')).counts,
    '1/1 assessed · 1 proven',
  );
});
