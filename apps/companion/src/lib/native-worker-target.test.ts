import assert from 'node:assert/strict';
import test from 'node:test';

import type { NativeSessionInfo, Run } from '@farmslot/protocol';

import {
  nativeWorkerViewControl,
  nativeWorkerViewForRun,
  type NativeWorkerViewSelection,
  type NativeWorkerViewTarget,
  sameNativeWorkerViewBinding,
} from './native-worker-target';

const target: NativeWorkerViewTarget = {
  runId: 'run',
  contextId: 'dev',
  label: 'Worker',
  readOnly: false,
  binding: {
    sessionId: 'session',
    executionNodeId: 'node',
    ownerPrincipalId: 'owner',
    leaseId: 'lease',
    generation: 'generation',
    commandId: 'initial',
    acceptedAt: 'accepted',
  },
};
const session = {
  id: 'session',
  executionNodeId: 'node',
  ownerPrincipalId: 'owner',
  generation: 'generation',
  workerLeaseId: 'lease',
} as NativeSessionInfo;

test('worker controls require the exact live task binding and refuse stale or historical selection', () => {
  assert.deepEqual(nativeWorkerViewControl(target, session), {
    runId: 'run',
    contextId: 'dev',
    generation: 'generation',
    leaseId: 'lease',
  });
  for (const field of [
    'id',
    'executionNodeId',
    'ownerPrincipalId',
    'generation',
    'workerLeaseId',
  ] as const)
    assert.equal(
      nativeWorkerViewControl(target, { ...session, [field]: 'other' }),
      undefined,
      field,
    );
  assert.equal(nativeWorkerViewControl({ ...target, readOnly: true }, session), undefined);
  for (const binding of [
    { ...target.binding, closedAt: 'closed' },
    { ...target.binding, releasedAt: 'transferred' },
    { ...target.binding, acceptedAt: undefined },
    { ...target.binding, recovery: { fromGeneration: 'generation', commandId: 'resume' } },
  ])
    assert.equal(nativeWorkerViewControl({ ...target, binding }, session), undefined);
});

const selection: NativeWorkerViewSelection = {
  runId: 'run',
  contextId: 'dev',
  sessionId: 'session',
  executionNodeId: 'node',
  leaseId: 'lease',
  generation: 'generation',
};
const run = {
  id: 'run',
  status: 'monitoring',
  agentContexts: [
    { id: 'dev', runId: 'run', label: 'Worker', role: 'primary', nativeSession: target.binding },
  ],
} as Run;

test('shared run selection preserves the pinned worker across unrelated metadata changes', () => {
  assert.deepEqual(nativeWorkerViewForRun(run, selection), target);
  assert.deepEqual(
    nativeWorkerViewForRun({ ...run, tags: ['external-change'] }, selection),
    target,
  );
  for (const field of [
    'runId',
    'contextId',
    'sessionId',
    'executionNodeId',
    'leaseId',
    'generation',
  ] as const)
    assert.equal(nativeWorkerViewForRun(run, { ...selection, [field]: 'other' }), undefined, field);
  assert.equal(nativeWorkerViewForRun(run, { ...selection, generation: '' }), undefined);
});

test('a pinned historical lease stays read-only and cannot select its successor', () => {
  const historical = { ...target.binding, releasedAt: 'released' };
  const value = {
    ...run,
    agentContexts: [
      {
        ...run.agentContexts![0],
        nativeSession: { ...target.binding, sessionId: 'successor', leaseId: 'next' },
        nativeSessionHistory: [historical],
      },
    ],
  };
  assert.deepEqual(nativeWorkerViewForRun(value, selection), {
    ...target,
    label: 'Worker · Attempt 1',
    binding: historical,
    readOnly: true,
  });
  assert.equal(nativeWorkerViewForRun({ ...run, status: 'done' }, selection)?.readOnly, true);
});

test('owner aliases require the exact declared session and lease', () => {
  const value = {
    ...run,
    agentContexts: [
      ...run.agentContexts!,
      {
        ...run.agentContexts![0],
        id: 'review',
        label: 'Review',
        nativeSession: undefined,
        nativeSessionOwner: { contextId: 'dev', sessionId: 'session', leaseId: 'lease' },
      },
    ],
  };
  assert.deepEqual(nativeWorkerViewForRun(value, { ...selection, contextId: 'review' }), {
    ...target,
    contextId: 'review',
    label: 'Review',
  });
  value.agentContexts[1].nativeSessionOwner!.leaseId = 'other';
  assert.equal(nativeWorkerViewForRun(value, { ...selection, contextId: 'review' }), undefined);
});

test('an ambiguous or removed task binding never chooses a conversation', () => {
  const ambiguous = {
    ...run,
    agentContexts: [{ ...run.agentContexts![0], nativeSessionHistory: [target.binding] }],
  };
  assert.equal(nativeWorkerViewForRun(ambiguous, selection), undefined);
  assert.equal(nativeWorkerViewForRun({ ...run, agentContexts: [] }, selection), undefined);
});

test('late transcript pages keep metadata changes but retire a different task owner', () => {
  assert(sameNativeWorkerViewBinding(target, { ...target, label: 'Updated', readOnly: true }));
  assert.equal(sameNativeWorkerViewBinding(target, undefined), false);
  for (const field of ['runId', 'contextId'] as const)
    assert.equal(sameNativeWorkerViewBinding(target, { ...target, [field]: 'other' }), false);
  for (const field of [
    'sessionId',
    'executionNodeId',
    'leaseId',
    'generation',
    'ownerPrincipalId',
  ] as const)
    assert.equal(
      sameNativeWorkerViewBinding(target, {
        ...target,
        binding: { ...target.binding, [field]: 'other' },
      }),
      false,
      field,
    );
});
