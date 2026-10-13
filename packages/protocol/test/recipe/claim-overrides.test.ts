import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildRunDecisionActionRequest,
  type ClaimOverrideAuthority,
  type ClaimUntestableOverrideReceipt,
  humanGateEnabled,
  isAuthorizedOverride,
  MARK_CLAIM_UNTESTABLE_ACTION,
  Methods,
  projectClaimUntestableOverride,
  type RecipeClaimEvidence,
  recordedEvidenceClosureIdentity,
  type RecordedEvidencePackageInput,
} from '../../src/index.js';

test('completion planning preserves the existing human gate policy', () => {
  assert.equal(humanGateEnabled('dev'), false);
  assert.equal(humanGateEnabled('review-pr'), true);
  assert.equal(humanGateEnabled('fix-bug', undefined, { human_gates: { 'fix-bug': false } }), true);
  assert.equal(humanGateEnabled('dev', 'autonomous'), true);
  assert.equal(humanGateEnabled('qa', 'autonomous', { human_gates: { qa: true } }), false);
  assert.equal(humanGateEnabled('qa', 'validation'), true);
  assert.equal(humanGateEnabled('qa', undefined, { human_gates: { qa: true } }), true);
  assert.equal(humanGateEnabled('qa', undefined, { human_gates: { qa: false } }), false);
});

const claim: RecipeClaimEvidence = {
  id: 'AC-1',
  text: 'The service responds.',
  kind: 'acceptance',
  proofMode: 'state',
  verdict: 'missing',
  recipeNodes: [],
  assertionIndices: [],
  moments: [],
  evidence: [],
};
const first: ClaimUntestableOverrideReceipt = {
  id: 'one',
  runId: 'run',
  decisionId: 'gate',
  claimId: claim.id,
  recipeRunId: 'execution',
  closureIdentity: 'closure',
  priorVerdict: 'missing',
  approver: { principalId: 'person', displayName: 'Reviewer', credentialId: 'credential' },
  reason: 'The service is unavailable.',
  overriddenAt: '2026-10-13T10:00:00Z',
};
const authority: ClaimOverrideAuthority = {
  runId: first.runId,
  recipeRunId: first.recipeRunId,
  closureIdentity: first.closureIdentity,
  receipts: [first],
};

test('one predicate accepts the full stored chain while preserving the engine verdict', () => {
  const before = structuredClone(claim);
  const second = {
    ...first,
    id: 'two',
    priorVerdict: 'untestable' as const,
    reason: 'Still unavailable.',
  };
  const current = { ...authority, receipts: [first, second] };
  const row = projectClaimUntestableOverride(claim, current);
  assert.equal(row.verdict, 'untestable');
  assert.equal(row.engineVerdict, 'missing');
  assert.equal(row.note, second.reason);
  assert.equal(isAuthorizedOverride(row, claim, current), true);
  assert.deepEqual(claim, before);
  assert.equal(
    isAuthorizedOverride({ ...row, overrides: [{ receiptId: 'two' }] }, claim, current),
    false,
  );
  for (const receipt of [
    { ...first, priorVerdict: 'proven' as const },
    { ...first, reason: ' ' },
    { ...first, approver: { ...first.approver, principalId: '' } },
    { ...first, overriddenAt: 'invalid' },
    { ...first, recipeRunId: 'other' },
    { ...first, closureIdentity: 'changed' },
    { ...first, runId: 'other' },
  ])
    assert.equal(
      isAuthorizedOverride(projectClaimUntestableOverride(claim, authority), claim, {
        ...authority,
        receipts: [receipt],
      }),
      false,
    );
  assert.equal(
    isAuthorizedOverride(row, claim, {
      ...authority,
      receipts: [first, { ...second, priorVerdict: 'missing' }],
    }),
    false,
  );
  assert.equal(isAuthorizedOverride(row, claim, { ...authority, receipts: [first, first] }), false);
  assert.deepEqual(projectClaimUntestableOverride(claim, { ...authority, receipts: [] }), claim);
});

test('closure binds actual file digests and execution independently of enumeration order', () => {
  const input: RecordedEvidencePackageInput = {
    summary: {},
    artifactDigests: {
      'trace.json': `sha256:${'a'.repeat(64)}`,
      'summary.json': `sha256:${'b'.repeat(64)}`,
    },
    timelines: {},
    claims: {
      schemaVersion: 2,
      recipeRunId: first.recipeRunId,
      criteria: [claim],
      recording: { status: 'not-required', segments: [] },
    },
  };
  const identity = recordedEvidenceClosureIdentity(input);
  assert.equal(
    recordedEvidenceClosureIdentity({ ...input, artifactPaths: ['summary.json', 'trace.json'] }),
    identity,
  );
  assert.notEqual(
    recordedEvidenceClosureIdentity({
      ...input,
      claims: { ...input.claims!, recipeRunId: 'other' },
    }),
    identity,
  );
  assert.notEqual(
    recordedEvidenceClosureIdentity({
      ...input,
      artifactDigests: { ...input.artifactDigests, 'trace.json': `sha256:${'c'.repeat(64)}` },
    }),
    identity,
  );
});

test('the shared action builder sends an override operation instead of decision resolution', () => {
  const request = buildRunDecisionActionRequest({
    runId: 'run',
    decision: {
      id: 'gate',
      payload: {
        kind: 'output-review',
        reportPath: 'artifacts/report.html',
        manifestDigest: 'digest',
      },
    },
    actionId: MARK_CLAIM_UNTESTABLE_ACTION,
    claimId: claim.id,
    recipeRunId: first.recipeRunId,
    claimOverrideReason: first.reason,
  });
  assert.equal(request.method, Methods.RUN_OVERRIDE_CLAIM);
  assert.equal('actionId' in request.params, false);
  assert.equal('actor' in request.params, false);
  assert.throws(
    () =>
      buildRunDecisionActionRequest({
        runId: 'run',
        decision: { id: 'gate' },
        actionId: MARK_CLAIM_UNTESTABLE_ACTION,
        claimOverrideReason: ' ',
      }),
    /requires/,
  );
});
