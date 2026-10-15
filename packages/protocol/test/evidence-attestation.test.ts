import assert from 'node:assert/strict';
import test from 'node:test';

import type { RunGateReadiness } from '../src/index.js';
import {
  APPROVE_PUBLISH_EVIDENCE_ATTESTED_ACTION,
  buildRunResolveDecisionParams,
  evidenceAttestationAvailable,
  evidenceAttestationReason,
  isEvidenceAttestationApprover,
  isEvidencePolicyReason,
  isPublishApprovalAction,
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
