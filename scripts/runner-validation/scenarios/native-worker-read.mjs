import assert from 'node:assert/strict';

import { rpc } from './native-worker-lifecycle.mjs';

/** Refresh generation within an explicitly selected task lease, never a successor. */
export function pinnedWorkerTarget(runId, contextId, leaseId) {
  const run = rpc('run.get', { runId }).run;
  const context = run.agentContexts.find((item) => item.id === contextId);
  assert.ok(context, 'Pinned worker context disappeared');
  const reference = context.nativeSessionOwner;
  const owner = reference
    ? run.agentContexts.find((item) => item.id === reference.contextId)
    : context;
  assert.ok(owner, 'Pinned worker history owner disappeared');
  const bindings = [owner.nativeSession, ...(owner.nativeSessionHistory ?? [])].filter(
    (binding) => binding?.leaseId === leaseId,
  );
  assert.equal(bindings.length, 1, 'Pinned task lease is absent or ambiguous');
  const binding = bindings[0];
  assert.ok(binding.generation, 'Pinned worker generation is not yet reconciled');
  if (reference) {
    assert.equal(reference.leaseId, leaseId);
    assert.equal(reference.sessionId, binding.sessionId);
  }
  return {
    sessionId: binding.sessionId,
    executionNodeId: binding.executionNodeId,
    worker: { runId, contextId, leaseId, generation: binding.generation },
  };
}
