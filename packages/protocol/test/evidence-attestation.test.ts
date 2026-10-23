import assert from 'node:assert/strict';
import test from 'node:test';

import type { ReadyGatePayload, RunGateReadiness } from '../src/index.js';
import {
  acceptReviewFindingsAvailable,
  APPROVE_PUBLISH_EVIDENCE_ATTESTED_ACTION,
  APPROVE_PUBLISH_UNRESOLVED_ACTION,
  buildRunResolveDecisionParams,
  evidenceAttestationAvailable,
  evidenceAttestationReason,
  gateActionsForReadiness,
  gateReasonsForAction,
  isEvidenceAttestationApprover,
  isEvidencePolicyReason,
  isPublishApprovalAction,
  publicationApprovalReasonFields,
  sameEvidenceAttestationApprover,
} from '../src/index.js';

const policy: RunGateReadiness = {
  state: 'not-ready',
  identity: { runId: 'run', generation: 1, packageHash: 'package' },
  reasons: [
    {
      code: 'evidence-policy-unsatisfied',
      prerequisite: 'evidence',
      evidencePolicy: 'criterion-binding',
      message: 'Claim text differs.',
    },
  ],
};

test('attestation admits only typed policy findings, not invalid/unknown evidence or other prerequisites', () => {
  assert.equal(evidenceAttestationAvailable(policy), true);
  assert.equal(evidenceAttestationAvailable({ ...policy, state: 'collecting' }), false);
  assert.equal(evidenceAttestationAvailable({ ...policy, reasons: [] }), false);
  for (const code of ['evidence-invalid', 'evidence-validation-unavailable', 'future-policy']) {
    assert.equal(isEvidencePolicyReason({ ...policy.reasons[0], code }), false);
    assert.equal(
      evidenceAttestationAvailable({ ...policy, reasons: [{ ...policy.reasons[0], code }] }),
      false,
    );
  }
  assert.equal(
    evidenceAttestationAvailable({
      ...policy,
      reasons: [
        ...policy.reasons,
        { code: 'ci-failed', prerequisite: 'deterministic', message: 'CI failed.' },
      ],
    }),
    false,
  );
  assert.equal(isPublishApprovalAction(APPROVE_PUBLISH_EVIDENCE_ATTESTED_ACTION), true);
});

test('shared request requires a reason and retains the visible package binding', () => {
  assert.throws(
    () => evidenceAttestationReason(APPROVE_PUBLISH_EVIDENCE_ATTESTED_ACTION, ' \n '),
    /written reason/,
  );
  assert.throws(() => evidenceAttestationReason('approve-publish', 'waive'), /requires attested/);
  const params = buildRunResolveDecisionParams({
    runId: 'run',
    decision: {
      id: 'decision',
      payload: {
        kind: 'ready',
        branch: 'branch',
        prNumber: null,
        repo: null,
        diffStat: { files: 0, additions: 0, deletions: 0 },
        reviews: [],
        workerReport: '',
        artifacts: [],
        prPackage: {
          id: 'pkg',
          packageHash: 'hash',
          headSha: 'head',
          selectedEvidenceKeys: ['artifacts/video.mp4'],
        },
      } as never,
    },
    actionId: APPROVE_PUBLISH_EVIDENCE_ATTESTED_ACTION,
    evidenceAttestationReason: ' Inspected the retained package. ',
  });
  assert.equal(params.evidenceAttestationReason, 'Inspected the retained package.');
  assert.equal(params.selectionData?.packageHash, 'hash');
  assert.equal(params.selectionData?.packageHeadSha, 'head');
});

test('approval provenance preserves legacy credentials and distinguishes person device sessions', () => {
  const identity = { principalId: 'person', displayName: 'Person' };
  const legacy = { ...identity, credentialId: 'authority' };
  const device = { ...identity, personSessionId: 'authority' };
  assert.equal(isEvidenceAttestationApprover(legacy), true);
  assert.equal(isEvidenceAttestationApprover(device), true);
  assert.equal(isEvidenceAttestationApprover(identity), false);
  assert.equal(isEvidenceAttestationApprover({ ...legacy, personSessionId: 'device' }), false);
  assert.equal(isEvidenceAttestationApprover({ ...device, credentialId: '' }), false);
  assert.equal(
    sameEvidenceAttestationApprover(device, { ...device, displayName: 'Renamed' }),
    true,
  );
  assert.equal(sameEvidenceAttestationApprover(device, legacy), false);
  assert.equal(
    sameEvidenceAttestationApprover(device, { ...device, personSessionId: 'other' }),
    false,
  );
  assert.equal(sameEvidenceAttestationApprover(device, { ...device, principalId: 'other' }), false);
});

test('accepting review findings needs the checked findings and yields only the review reasons', () => {
  const accepting: RunGateReadiness = {
    state: 'not-ready',
    identity: policy.identity,
    reasons: [
      {
        code: 'review-fix-required',
        prerequisite: 'review',
        message: 'Review rounds spent: 1 issue open',
        allowedReviewOverrides: [APPROVE_PUBLISH_UNRESOLVED_ACTION],
      },
    ],
    findings: [{ reviewId: 'review', file: 'src/a.ts', description: 'Open finding' }],
    findingsDigest: 'sha256:findings',
  };
  const actions = [
    { id: 'approve-publish' },
    { id: APPROVE_PUBLISH_UNRESOLVED_ACTION },
    { id: 'hold' },
  ];
  assert.equal(acceptReviewFindingsAvailable(accepting), true);
  assert.deepEqual(gateActionsForReadiness(actions, accepting), actions.slice(1));
  for (const withheld of [
    { ...accepting, findings: [] },
    { ...accepting, findingsDigest: undefined },
    {
      ...accepting,
      reasons: [{ ...accepting.reasons[0]!, allowedReviewOverrides: [] }],
    },
  ]) {
    assert.equal(acceptReviewFindingsAvailable(withheld), false);
    assert.deepEqual(gateActionsForReadiness(actions, withheld), [{ id: 'hold' }]);
  }
  // The shared request echoes the digest of the findings this client shows.
  const payload: ReadyGatePayload = {
    kind: 'ready',
    prNumber: null,
    repo: null,
    diffStat: { files: 0, additions: 0, deletions: 0 },
    workerReport: '',
    branch: 'branch',
    gateReadiness: accepting,
  };
  const params = buildRunResolveDecisionParams({
    runId: 'run',
    decision: { id: 'decision', payload },
    actionId: APPROVE_PUBLISH_UNRESOLVED_ACTION,
    reason: ' The owner accepts it. ',
  });
  assert.equal(params.findingsDigest, 'sha256:findings');
  assert.equal(params.reason, 'The owner accepts it.');
  assert.equal(
    buildRunResolveDecisionParams({
      runId: 'run',
      decision: { id: 'decision', payload },
      actionId: 'hold',
    }).findingsDigest,
    undefined,
  );
});

test('one combined approval accepts findings and attests only the accompanying evidence-policy gap', () => {
  const combined: RunGateReadiness = {
    ...policy,
    reasons: [
      {
        code: 'review-fix-required',
        prerequisite: 'review',
        message: 'Review rounds spent: 2 issues open',
        allowedReviewOverrides: [APPROVE_PUBLISH_UNRESOLVED_ACTION],
      },
      { ...policy.reasons[0]!, evidencePolicy: 'claim-verdict' },
    ],
    findings: [
      { reviewId: 'review', file: 'evidence-manifest.json', description: 'Missing state proof' },
    ],
    findingsDigest: 'sha256:findings',
  };
  assert.equal(acceptReviewFindingsAvailable(combined), true);
  assert.equal(evidenceAttestationAvailable(combined), false);
  assert.equal(evidenceAttestationAvailable(combined, APPROVE_PUBLISH_UNRESOLVED_ACTION), true);
  assert.deepEqual(gateReasonsForAction(combined, APPROVE_PUBLISH_UNRESOLVED_ACTION), []);
  assert.deepEqual(
    gateActionsForReadiness(
      [
        { id: APPROVE_PUBLISH_UNRESOLVED_ACTION },
        { id: APPROVE_PUBLISH_EVIDENCE_ATTESTED_ACTION },
        { id: 'hold' },
      ],
      combined,
    ).map(({ id }) => id),
    [APPROVE_PUBLISH_UNRESOLVED_ACTION, 'hold'],
  );
  for (const code of [
    'review-result-required',
    'review-result-invalid',
    'evidence-invalid',
    'publication-secret-values',
    'deterministic-not-passed',
    'acceptance-incomplete',
    'run-work-progressing',
  ]) {
    const withheld: RunGateReadiness = {
      ...combined,
      reasons: [
        ...combined.reasons,
        { code, prerequisite: 'evidence', message: 'Another prerequisite still blocks.' },
      ],
    };
    assert.equal(acceptReviewFindingsAvailable(withheld), false, code);
    assert.equal(
      evidenceAttestationAvailable(withheld, APPROVE_PUBLISH_UNRESOLVED_ACTION),
      false,
      code,
    );
    assert.ok(gateReasonsForAction(withheld, APPROVE_PUBLISH_UNRESOLVED_ACTION).length > 0, code);
  }
  for (const withheld of [
    { ...combined, state: 'collecting' as const },
    { ...combined, findings: [] },
    { ...combined, findingsDigest: undefined },
    {
      ...combined,
      reasons: [{ ...combined.reasons[0]!, allowedReviewOverrides: [] }, combined.reasons[1]!],
    },
  ])
    assert.equal(acceptReviewFindingsAvailable(withheld), false);
  const fields = publicationApprovalReasonFields(
    APPROVE_PUBLISH_UNRESOLVED_ACTION,
    'I accept and attest.',
    true,
  );
  assert.deepEqual(fields, {
    reason: 'I accept and attest.',
    evidenceAttestationReason: 'I accept and attest.',
  });
  assert.deepEqual(
    publicationApprovalReasonFields(APPROVE_PUBLISH_UNRESOLVED_ACTION, 'Accept only.'),
    { reason: 'Accept only.' },
  );
  assert.equal(
    evidenceAttestationReason(APPROVE_PUBLISH_UNRESOLVED_ACTION, fields.evidenceAttestationReason),
    'I accept and attest.',
  );
});
