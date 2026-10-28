import assert from 'node:assert/strict';
import test from 'node:test';

import {
  APPROVE_PUBLISH_EVIDENCE_ATTESTED_ACTION,
  APPROVE_PUBLISH_UNRESOLVED_ACTION,
  createReviewCuration,
  Methods,
  type ReadyGatePayload,
  type ReviewGatePayload,
} from '@farmslot/protocol';

import {
  decisionResolveRequest,
  gateActionReasons,
  sendDecisionResolveRequest,
} from './decision-resolve';

test('native attestation requires the run and sends the shared reason and package identity', () => {
  const action = APPROVE_PUBLISH_EVIDENCE_ATTESTED_ACTION;
  assert.throws(
    () => decisionResolveRequest({ id: 'gate' }, action, null, undefined, 'Inspected'),
    /Load the publish run/,
  );
  const decision = { id: 'gate', payload, runMeta: { runId: 'run' } as never };
  assert.throws(() => decisionResolveRequest(decision, action), /written reason/);
  const request = decisionResolveRequest(
    decision,
    action,
    null,
    undefined,
    ' Inspected retained evidence. ',
  );
  assert.equal(request.method, Methods.RUN_RESOLVE_DECISION);
  assert.equal(
    (request.params as { evidenceAttestationReason?: string }).evidenceAttestationReason,
    'Inspected retained evidence.',
  );
  assert.equal(
    (request.params as { selectionData?: { packageHash?: string } }).selectionData?.packageHash,
    'hash-1',
  );
});

const payload = {
  kind: 'ready',
  publicationTarget: 'draft',
  prPackage: {
    id: 'pkg-1',
    packageHash: 'hash-1',
    headSha: 'abc123',
    publicationTarget: 'ready',
    selectedEvidenceKeys: ['after.png'],
  },
} as unknown as ReadyGatePayload;

test('curated review posting requires its run and forwards an explicit empty selection', () => {
  const review: ReviewGatePayload = {
    kind: 'review',
    repo: 'example/app',
    prNumber: 42,
    reviewMd: 'Saved report',
    recommendation: 'COMMENT',
    lineComments: [],
  };
  assert.throws(
    () => decisionResolveRequest({ id: 'review', payload: review }, 'post'),
    /Load the review run/,
  );
  const curation = createReviewCuration(review);
  const request = decisionResolveRequest(
    { id: 'review', payload: review, runMeta: { runId: 'run' } as never },
    'post',
    null,
    { ...curation },
  );
  assert.equal(request.method, Methods.RUN_RESOLVE_DECISION);
  assert.deepEqual((request.params as { selectionData: unknown }).selectionData, curation);
});

test('a run decision resolves through run.resolveDecision bound to the reviewed package', () => {
  assert.deepEqual(
    decisionResolveRequest({ id: 'gate-1', payload, runMeta: { runId: 'run-1' } as never }, 'hold'),
    {
      method: Methods.RUN_RESOLVE_DECISION,
      params: {
        runId: 'run-1',
        decisionId: 'gate-1',
        actionId: 'hold',
        selectionData: {
          publicationTarget: 'draft',
          selectedEvidenceKeys: ['after.png'],
          packageId: 'pkg-1',
          packageHash: 'hash-1',
          packageHeadSha: 'abc123',
        },
      },
    },
  );
});

test('a posture choice rides only on run.resolveDecision', () => {
  const request = decisionResolveRequest(
    { id: 'gate-1', payload, runMeta: { runId: 'run-1' } as never },
    'hold',
    'keep-for-validation',
  );
  assert.equal(request.method, Methods.RUN_RESOLVE_DECISION);
  assert.equal(
    (request.params as { resourcePosture?: unknown }).resourcePosture,
    'keep-for-validation',
  );
});

test('a decision without its run resolves through decision.resolve', () => {
  assert.deepEqual(decisionResolveRequest({ id: 'gate-1' }, 'hold', 'keep-for-validation'), {
    method: Methods.DECISION_RESOLVE,
    params: { decisionId: 'gate-1', actionId: 'hold' },
  });
});

test('a slot pick carries the chosen candidate on run.resolveDecision', () => {
  const request = decisionResolveRequest(
    { id: 'pick-1', runMeta: { runId: 'run-1' } as never },
    'pick',
    null,
    { slotId: 'slot-2' },
  );
  assert.deepEqual(request, {
    method: Methods.RUN_RESOLVE_DECISION,
    params: {
      runId: 'run-1',
      decisionId: 'pick-1',
      actionId: 'pick',
      selectionData: { slotId: 'slot-2' },
    },
  });
});

test("an improvement's Apply writes and validates through improvement.apply", () => {
  assert.deepEqual(
    decisionResolveRequest(
      { id: 'improve-1', type: 'improvement', runMeta: { runId: 'run-1' } as never },
      'apply',
    ),
    {
      method: Methods.IMPROVEMENT_APPLY,
      params: { runId: 'run-1', decisionId: 'improve-1' },
    },
  );
});

test('a result decision sends its written reason with run.resolveDecision', () => {
  const request = decisionResolveRequest(
    {
      id: 'result-1',
      payload: undefined,
      runMeta: { runId: 'run-1', flowType: 'dev', ticketOrPr: 'TAT-4145' },
    },
    'accept-result',
    null,
    undefined,
    undefined,
    ' Known findings on a comparison lane. ',
  );
  assert.equal(request.method, Methods.RUN_RESOLVE_DECISION);
  assert.equal(
    (request.params as { reason?: string }).reason,
    'Known findings on a comparison lane.',
  );
});

test('accepting review findings sends the typed reason and the digest of the findings shown', () => {
  const accepting: ReadyGatePayload = {
    kind: 'ready',
    prNumber: null,
    repo: null,
    diffStat: { files: 0, additions: 0, deletions: 0 },
    workerReport: '',
    branch: 'branch',
    gateReadiness: {
      state: 'not-ready',
      identity: { runId: 'run', generation: 1 },
      reasons: [],
      findings: [{ reviewId: 'review', file: 'src/a.ts', description: 'Open finding' }],
      findingsDigest: 'sha256:shown',
    },
  };
  const decision = {
    id: 'gate',
    payload: accepting,
    runMeta: { runId: 'run', flowType: 'dev' as const, ticketOrPr: 'TAT-1' },
  };
  const reasons = gateActionReasons(APPROVE_PUBLISH_UNRESOLVED_ACTION, 'The owner accepts it.');
  const { params } = decisionResolveRequest(
    decision,
    APPROVE_PUBLISH_UNRESOLVED_ACTION,
    null,
    undefined,
    reasons.evidenceAttestationReason,
    reasons.reason,
  );
  assert.deepEqual(reasons, { reason: 'The owner accepts it.' });
  assert.deepEqual(gateActionReasons('hold', 'ignored'), {});
  assert.equal('reason' in params && params.reason, 'The owner accepts it.');
  assert.equal('findingsDigest' in params && params.findingsDigest, 'sha256:shown');
  assert.throws(
    () => decisionResolveRequest({ id: 'gate' }, APPROVE_PUBLISH_UNRESOLVED_ACTION),
    /Load the publish run before accepting review findings/,
  );
});

test('combined consent sends one written reason in both existing receipt fields', () => {
  assert.deepEqual(
    gateActionReasons(APPROVE_PUBLISH_UNRESOLVED_ACTION, 'I accept and attest.', true),
    {
      reason: 'I accept and attest.',
      evidenceAttestationReason: 'I accept and attest.',
    },
  );
  assert.deepEqual(gateActionReasons(APPROVE_PUBLISH_UNRESOLVED_ACTION, 'I accept only.'), {
    reason: 'I accept only.',
  });
});

// Pins the decision workspace fallback: each resolve names its literal method; anything else is refused.
test('a confirmed resolve is sent only through its literal resolve transport', async () => {
  const sent: Array<{ method: string; timeout?: number | null }> = [];
  const client = {
    request: async <R>(method: string, _params?: unknown, timeout?: number | null) => {
      sent.push({ method, timeout });
      return { ok: true } as R;
    },
  };
  for (const method of [
    Methods.RUN_RESOLVE_DECISION,
    Methods.IMPROVEMENT_APPLY,
    Methods.DECISION_RESOLVE,
  ] as const)
    await sendDecisionResolveRequest(client, { method, params: { decisionId: 'd' } } as never);
  assert.deepEqual(
    sent.map(({ method }) => method),
    [Methods.RUN_RESOLVE_DECISION, Methods.IMPROVEMENT_APPLY, Methods.DECISION_RESOLVE],
  );
  assert.equal(sent[0].timeout, undefined, 'the caller keeps the client default timeout');

  await assert.rejects(
    sendDecisionResolveRequest(client, {
      method: Methods.RUN_OVERRIDE_CLAIM,
      params: { runId: 'r', decisionId: 'd' },
    } as never),
    /does not send run\.overrideClaim/,
  );
  assert.equal(sent.length, 3, 'a claim override is never sent as a resolve');
});

