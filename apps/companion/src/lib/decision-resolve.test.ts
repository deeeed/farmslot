import assert from 'node:assert/strict';
import test from 'node:test';

import { Methods, type ReadyGatePayload } from '@farmslot/protocol';

import { decisionResolveRequest } from './decision-resolve';

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
