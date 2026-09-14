import assert from 'node:assert/strict';
import test from 'node:test';

import type { NativeSessionReadResult, NativeWorkerSessionBinding } from '@farmslot/protocol';

import { shouldHoldForMissingTerminalSignal } from '../../run-engine/run-monitor.js';

import { assertNativeWorkerSnapshot, nativeWorkerLiveStatus } from './worker-control.js';

const binding: NativeWorkerSessionBinding = {
  sessionId: 'session',
  generation: 'generation',
  leaseId: 'task',
  commandId: 'command',
  ownerPrincipalId: 'owner',
  executionNodeId: 'node',
};
function snapshot(state: NativeSessionReadResult['session']['state']): NativeSessionReadResult {
  return {
    session: {
      id: binding.sessionId,
      generation: binding.generation!,
      workerLeaseId: binding.leaseId,
      ownerPrincipalId: binding.ownerPrincipalId,
      executionNodeId: binding.executionNodeId,
      state,
      processPid: 123,
      hostPid: 122,
      runner: 'codex',
      nativeSessionId: 'conversation',
      accountContextId: 'account',
      cwd: '/fixture',
      executable: 'codex',
      version: 'fixture',
      mode: 'default',
      accountMode: 'native',
      capabilities: {
        modes: ['default'],
        streaming: true,
        tools: true,
        approvals: true,
        questions: true,
        interrupt: true,
        resume: true,
      },
    },
    events: [],
    pendingRequests: [],
    commands: [],
    cursor: 0,
    hasMore: false,
  };
}

test('native idle and waiting remain live; uncertain process cleanup is never a completed task', () => {
  for (const state of ['idle', 'running', 'waiting'] as const)
    assert.equal(nativeWorkerLiveStatus(snapshot(state)), 'working');
  for (const state of ['closed', 'failed'] as const) {
    const read = snapshot(state);
    assert.equal(nativeWorkerLiveStatus(read), 'unknown');
    read.session.processStopped = true;
    assert.equal(nativeWorkerLiveStatus(read), 'idle');
  }
  assert.equal(nativeWorkerLiveStatus(snapshot('starting')), 'unknown');
  assert.equal(
    shouldHoldForMissingTerminalSignal(
      { requireSignal: false },
      {
        transport: 'native',
        flowType: 'pr-complete',
        mode: 'interactive',
      },
    ),
    true,
  );
  assert.equal(
    shouldHoldForMissingTerminalSignal(
      { requireSignal: false },
      {
        transport: 'tmux',
        flowType: 'pr-complete',
        mode: 'interactive',
      },
    ),
    false,
  );
});

test('native observation rejects another owner, node, session, generation or task lease', () => {
  assert.doesNotThrow(() => assertNativeWorkerSnapshot(binding, snapshot('idle')));
  for (const key of [
    'id',
    'generation',
    'ownerPrincipalId',
    'executionNodeId',
    'workerLeaseId',
  ] as const) {
    const read = snapshot('idle');
    read.session[key] = 'different';
    assert.throws(() => assertNativeWorkerSnapshot(binding, read), /changed/);
  }
});

test('worker observations reject another profile registration even with the same task lease', () => {
  const profile = {
    executionNodeId: binding.executionNodeId,
    runner: 'codex',
    profileId: 'work',
    accountContextId: '00000000-0000-4000-8000-000000000001',
  };
  const read = snapshot('idle');
  read.session.profileId = profile.profileId;
  read.session.accountContextId = profile.accountContextId;
  assert.doesNotThrow(() => assertNativeWorkerSnapshot({ ...binding, profile }, read));
  for (const field of ['executionNodeId', 'runner'] as const)
    assert.throws(
      () =>
        assertNativeWorkerSnapshot(
          { ...binding, profile: { ...profile, [field]: 'different' } },
          read,
        ),
      /changed/,
    );
  assert.throws(() => assertNativeWorkerSnapshot(binding, read), /changed/);
  read.session.accountContextId = 'another-registration';
  assert.throws(() => assertNativeWorkerSnapshot({ ...binding, profile }, read), /changed/);
});
