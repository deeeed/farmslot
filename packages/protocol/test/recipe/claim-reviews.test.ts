import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  digestRecipeDocument,
  parseProjectVisualClaimReviewPolicy,
  type RecipeVisualJudgmentReceipt,
  recordedEvidenceClosureIdentity,
  type RecordedEvidencePackageInput,
  recordedVisualJudgments,
  reviewedVisualFiles,
} from '../../src/recipe/index.js';

const input: RecordedEvidencePackageInput = JSON.parse(
  readFileSync(
    new URL('../../../recipe-runner/test/fixtures/visual-review-package.json', import.meta.url),
    'utf8',
  ),
).input;
const receipt: RecipeVisualJudgmentReceipt = {
  id: 'review-1',
  runId: 'run-1',
  claimId: 'check-1',
  recipeRunId: input.claims!.recipeRunId,
  closureIdentity: recordedEvidenceClosureIdentity(input),
  snapshotIdentity: 'captured',
  verdict: 'confirmed',
  moments: input.claims!.criteria.find(({ id }) => id === 'check-1')!.moments,
  approver: { principalId: 'person-1', credentialId: 'credential-1', displayName: 'Reviewer' },
  reason: 'The retained view shows the expected value.',
  judgedAt: '2026-10-14T00:00:00Z',
};
const authority = (receipts: RecipeVisualJudgmentReceipt[]) => ({
  runId: receipt.runId,
  recipeRunId: receipt.recipeRunId,
  closureIdentity: receipt.closureIdentity,
  receipts,
});

test('delegated receipts bind own identity, policy, parent restrictions and checked visual bytes', () => {
  const policy = parseProjectVisualClaimReviewPolicy({
    delegatedReviewerPrincipalIds: ['lead-reviewer'],
    delegatorPrincipalId: 'person-1',
  })!;
  const delegated: RecipeVisualJudgmentReceipt = {
    ...receipt,
    kind: 'lead-agent-reviewed',
    reviewerSubjectKind: 'service',
    approver: {
      principalId: 'lead-reviewer',
      credentialId: 'own-credential',
      displayName: 'Lead reviewer',
    },
    reviewedFiles: reviewedVisualFiles(input, receipt.claimId),
    delegation: {
      principalId: 'person-1',
      displayName: 'Operator',
      policyDigest: digestRecipeDocument(policy),
    },
  };
  const authorized = { ...authority([delegated]), projectPolicy: policy };
  const result = recordedVisualJudgments(input, authorized);
  assert.equal(result.length, 1);
  assert.equal(result[0]!.kind, 'lead-agent-reviewed');
  assert.equal(result[0]!.actor, 'lead-reviewer');
  assert.ok(delegated.reviewedFiles!.length);
  assert.deepEqual(recordedVisualJudgments(input, authority([delegated])), []);
  const changedPolicy = {
    ...policy,
    delegatedReviewerPrincipalIds: [...policy.delegatedReviewerPrincipalIds, 'unrelated-reviewer'],
  };
  assert.deepEqual(
    recordedVisualJudgments(input, { ...authorized, projectPolicy: changedPolicy }),
    [],
  );
  assert.equal(
    recordedVisualJudgments(input, {
      ...authorized,
      projectPolicy: changedPolicy,
      historical: true,
    }).length,
    1,
  );
  assert.deepEqual(
    recordedVisualJudgments(
      {
        ...input,
        artifactDigests: { ...input.artifactDigests, 'video.mp4': 'sha256:' + 'b'.repeat(64) },
      },
      { ...authorized, projectPolicy: changedPolicy, historical: true },
    ),
    [],
  );

  for (const patch of [
    { reviewerSubjectKind: 'person' as const },
    { reviewedFiles: [] },
    { reviewedFiles: [{ path: 'video.mp4', digest: `sha256:${'a'.repeat(64)}` }] },
    { delegation: { ...delegated.delegation!, principalId: 'another-person' } },
  ])
    assert.deepEqual(
      recordedVisualJudgments(input, { ...authorized, receipts: [{ ...delegated, ...patch }] }),
      [],
    );
  for (const changed of [
    { ...policy, delegatedReviewerPrincipalIds: ['foreign-reviewer'] },
    { ...policy, personOnlyClaimIds: ['check-1'] },
    { ...policy, personOnlyClaimIds: ['case-1'] },
  ])
    assert.deepEqual(
      recordedVisualJudgments(input, {
        ...authorized,
        projectPolicy: changed,
        receipts: [
          {
            ...delegated,
            delegation: { ...delegated.delegation!, policyDigest: digestRecipeDocument(changed) },
          },
        ],
      }),
      [],
    );
});

test('project review policy rejects malformed grants and normalizes claim identifiers', () => {
  assert.equal(parseProjectVisualClaimReviewPolicy(undefined), undefined);
  for (const policy of [
    {},
    { delegatorPrincipalId: '', delegatedReviewerPrincipalIds: [] },
    { delegatorPrincipalId: 'person', delegatedReviewerPrincipalIds: [''] },
    { delegatorPrincipalId: 'person', delegatedReviewerPrincipalIds: [], actor: 'spoof' },
  ])
    assert.throws(() => parseProjectVisualClaimReviewPolicy(policy), /Invalid project/);
  assert.deepEqual(
    parseProjectVisualClaimReviewPolicy({
      delegatorPrincipalId: 'person',
      delegatedReviewerPrincipalIds: ['lead', 'lead'],
      personOnlyClaimIds: ['ac1'],
    }),
    {
      delegatorPrincipalId: 'person',
      delegatedReviewerPrincipalIds: ['lead'],
      personOnlyClaimIds: ['AC-1'],
    },
  );
});

test('visual judgments use the gateway person and preserve recorded order', () => {
  const later = {
    ...receipt,
    id: 'review-2',
    verdict: 'rejected' as const,
    judgedAt: '2026-10-13T00:00:00Z',
  };
  const result = recordedVisualJudgments(input, authority([receipt, later]));
  assert.deepEqual(
    result.map(({ receiptId, actor, verdict }) => ({ receiptId, actor, verdict })),
    [
      { receiptId: 'review-1', actor: 'person-1', verdict: 'confirmed' },
      { receiptId: 'review-2', actor: 'person-1', verdict: 'rejected' },
    ],
  );
});

test('unrelated identity, moments, bytes or incomplete person fields grant no judgment', () => {
  for (const invalid of [
    { ...receipt, runId: 'other-run' },
    { ...receipt, recipeRunId: 'other-execution' },
    { ...receipt, closureIdentity: 'other-bytes' },
    { ...receipt, moments: [] },
    { ...receipt, approver: { ...receipt.approver, credentialId: '' } },
    { ...receipt, reason: '', verdict: 'rejected' as const },
  ])
    assert.deepEqual(recordedVisualJudgments(input, authority([invalid])), []);
  assert.deepEqual(
    recordedVisualJudgments(
      {
        ...input,
        artifactDigests: { ...input.artifactDigests, 'video.mp4': `sha256:${'b'.repeat(64)}` },
      },
      authority([receipt]),
    ),
    [],
  );
});

test('person device receipts retain visual judgments while delegated services still require credentials', () => {
  const deviceReceipt: RecipeVisualJudgmentReceipt = {
    ...receipt,
    approver: { principalId: 'person-1', displayName: 'Reviewer', personSessionId: 'device-1' },
  };
  assert.equal(recordedVisualJudgments(input, authority([deviceReceipt])).length, 1);
  const delegated: RecipeVisualJudgmentReceipt = {
    ...deviceReceipt,
    kind: 'lead-agent-reviewed',
    reviewerSubjectKind: 'service',
    reviewedFiles: reviewedVisualFiles(input, receipt.claimId),
    delegation: {
      principalId: 'person-1',
      displayName: 'Reviewer',
      policyDigest: digestRecipeDocument({
        delegatedReviewerPrincipalIds: ['person-1'],
        delegatorPrincipalId: 'person-1',
      }),
    },
  };
  assert.deepEqual(
    recordedVisualJudgments(input, { ...authority([delegated]), historical: true }),
    [],
  );
});

test('only qualified person confirmation may omit its rationale', () => {
  const { reason: _reason, ...confirmation } = receipt;
  assert.equal(recordedVisualJudgments(input, authority([confirmation])).length, 1);
  assert.equal('reason' in recordedVisualJudgments(input, authority([confirmation]))[0]!, false);
  assert.deepEqual(
    recordedVisualJudgments(input, authority([{ ...confirmation, verdict: 'rejected' }])),
    [],
  );
  assert.deepEqual(
    recordedVisualJudgments(
      input,
      authority([{ ...confirmation, kind: 'lead-agent-reviewed', reviewerSubjectKind: 'service' }]),
    ),
    [],
  );
  assert.deepEqual(
    recordedVisualJudgments(input, authority([{ ...confirmation, closureIdentity: 'other' }])),
    [],
  );
});
