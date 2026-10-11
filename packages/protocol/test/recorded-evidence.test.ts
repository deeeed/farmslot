import assert from 'node:assert/strict';
import test from 'node:test';

import { validateRecipeDocument } from '../src/recipe/document.js';
import {
  DEFAULT_RECORDED_EVIDENCE_POLICY,
  EVIDENCE_PADDING_MS,
  normalizeRecipeClaimId,
  validateRecipeClaimDeclarations,
} from '../src/recipe/evidence.js';

test('claim registration preserves ordinary proof targets and normalizes task AC ids', () => {
  assert.equal(normalizeRecipeClaimId('AC1'), 'AC-1');
  assert.equal(normalizeRecipeClaimId('scenario/check'), 'scenario/check');
  assert.equal(
    validateRecipeClaimDeclarations([{ id: 'AC1', claim: 'The count changes.' }]).status,
    'valid',
  );
  assert.equal(
    validateRecipeClaimDeclarations([
      { id: 'AC1', claim: 'The count changes.' },
      { id: 'AC-1', claim: 'A second spelling cannot register the same claim.' },
    ]).status,
    'invalid',
  );
});

test('QA checks register under one case and reject missing or cyclic parent claims', () => {
  const caseClaim = { id: 'case-a', claim: 'The counter works.', kind: 'qa-case' };
  assert.equal(
    validateRecipeClaimDeclarations([
      caseClaim,
      { id: 'increment', claim: 'The counter increases.', kind: 'qa-check', parentId: 'case-a' },
    ]).status,
    'valid',
  );
  assert.equal(
    validateRecipeClaimDeclarations([
      { id: 'increment', claim: 'It increases.', parentId: 'absent' },
    ]).status,
    'invalid',
  );
  assert.equal(
    validateRecipeClaimDeclarations([
      { ...caseClaim, parentId: 'increment' },
      { id: 'increment', claim: 'It increases.', parentId: 'case-a' },
    ]).status,
    'invalid',
  );
});

test('a parent case is derived from its check rather than requiring a second prover', () => {
  const recipe = {
    $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
    proofTargets: [
      { id: 'case-a', claim: 'The counter works.', kind: 'qa-case' },
      { id: 'increment', claim: 'It increases.', kind: 'qa-check', parentId: 'case-a' },
    ],
    workflow: {
      entry: 'read',
      nodes: {
        read: {
          action: 'state_read',
          path: 'count.json',
          intent: 'Read the counter.',
          next: 'assert',
        },
        assert: {
          action: 'assert_output',
          source: 'read',
          contains: '1',
          intent: 'Require the incremented count.',
          proves: ['increment'],
          next: 'done',
        },
        done: { action: 'end', status: 'pass' },
      },
    },
  };
  const result = validateRecipeDocument(recipe);
  assert.equal(result.status, 'valid', JSON.stringify(result.findings));
});

test('unknown claim mode and undeclared fields refuse instead of inventing evidence', () => {
  for (const fields of [{ proofMode: 'trust-me' }, { kind: 'release' }, { startMs: 42 }]) {
    assert.equal(
      validateRecipeClaimDeclarations([{ id: 'AC1', claim: 'The count changes.', ...fields }])
        .status,
      'invalid',
    );
  }
  assert.equal(EVIDENCE_PADDING_MS, 1_000);
  assert.equal(DEFAULT_RECORDED_EVIDENCE_POLICY.mode, 'auto');
});
