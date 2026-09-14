import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  AgentContext,
  NativeWorkerControlTarget,
  NativeWorkerSessionBinding,
  Run,
} from '@farmslot/protocol';

import { nativeWorkerHistoryBinding } from './worker-history.js';

const binding: NativeWorkerSessionBinding = {
  sessionId: 'session',
  leaseId: 'old-lease',
  generation: 'generation',
  executionNodeId: 'local',
  ownerPrincipalId: 'owner',
  commandId: 'command',
  releasedAt: 'released',
};
const target: NativeWorkerControlTarget = {
  runId: 'run',
  contextId: 'fix',
  leaseId: binding.leaseId,
  generation: binding.generation!,
};
const owner = {
  id: 'owner',
  runId: 'run',
  slotId: 'slot',
  nativeSession: { ...binding, leaseId: 'new-lease' },
  nativeSessionHistory: [binding],
} as AgentContext;
const context = {
  id: 'fix',
  runId: 'run',
  slotId: 'slot',
  nativeSessionOwner: {
    contextId: owner.id,
    sessionId: binding.sessionId,
    leaseId: binding.leaseId,
  },
} as AgentContext;
const run = { id: 'run', status: 'monitoring', agentContexts: [owner, context] } as Run;

test('task history resolves an exact archived owner lease without adopting its successor', () => {
  assert.deepEqual(nativeWorkerHistoryBinding(run, target), { binding, readOnly: true });
  assert.equal(nativeWorkerHistoryBinding(run, { ...target, leaseId: 'new-lease' }), undefined);
  assert.equal(nativeWorkerHistoryBinding(run, { ...target, generation: 'other' }), undefined);
  assert.equal(
    nativeWorkerHistoryBinding(
      { ...run, agentContexts: [{ ...owner, nativeSessionHistory: [] }, context] },
      target,
    ),
    undefined,
  );
  assert.equal(
    nativeWorkerHistoryBinding(
      { ...run, agentContexts: [owner, { ...context, slotId: 'other' }] },
      target,
    ),
    undefined,
  );
  assert.equal(
    nativeWorkerHistoryBinding(
      { ...run, agentContexts: [owner, { ...context, nativeSession: binding }] },
      target,
    ),
    undefined,
  );
});
