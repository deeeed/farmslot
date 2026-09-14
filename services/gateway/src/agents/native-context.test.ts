import assert from 'node:assert/strict';
import test from 'node:test';

import type { AgentContext } from '@farmslot/protocol';

import { resolveNativeContext } from './native-context.js';

function fixture() {
  const owner: AgentContext = {
    id: 'dev',
    role: 'dev',
    runId: 'run',
    slotId: 'slot',
    label: 'Worker',
    status: 'working',
    nativeSession: {
      sessionId: 'session',
      generation: 'generation',
      leaseId: 'lease',
      commandId: 'initial',
      ownerPrincipalId: 'owner',
      executionNodeId: 'local',
    },
  };
  const fix: AgentContext = {
    id: 'self-review-fix',
    role: 'self-review-fix',
    runId: 'run',
    slotId: 'slot',
    label: 'Fix',
    status: 'working',
    nativeSessionOwner: { contextId: owner.id, sessionId: 'session', leaseId: 'lease' },
  };
  return { owner, fix, run: { agentContexts: [owner, fix] } };
}

test('fix references follow recovered generations but cannot adopt a replacement session or lease', () => {
  const { owner, fix, run } = fixture();
  assert.equal(resolveNativeContext(run, fix)?.owner, owner);
  owner.nativeSession!.generation = 'recovered';
  assert.equal(resolveNativeContext(run, fix)?.binding.generation, 'recovered');
  owner.nativeSession!.leaseId = 'successor';
  assert.equal(resolveNativeContext(run, fix), null);
  owner.nativeSession!.leaseId = 'lease';
  owner.nativeSession!.sessionId = 'fresh-task';
  assert.equal(resolveNativeContext(run, fix), null);
});

test('cross-run, cross-slot, indirect, released and ambiguous owners cannot resolve', () => {
  for (const mutate of [
    ({ owner }: ReturnType<typeof fixture>) => {
      owner.runId = 'other';
    },
    ({ owner }: ReturnType<typeof fixture>) => {
      owner.slotId = 'other';
    },
    ({ owner, fix }: ReturnType<typeof fixture>) => {
      owner.nativeSessionOwner = fix.nativeSessionOwner;
    },
    ({ owner }: ReturnType<typeof fixture>) => {
      owner.nativeSession!.releasedAt = 'released';
    },
    ({ owner, run }: ReturnType<typeof fixture>) => {
      run.agentContexts.push({ ...owner });
    },
  ]) {
    const data = fixture();
    mutate(data);
    assert.equal(resolveNativeContext(data.run, data.fix), null);
  }
  const { run, fix, owner } = fixture();
  fix.nativeSession = owner.nativeSession;
  assert.throws(() => resolveNativeContext(run, fix), /both own and reference/);
});
