import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  MachinePauseNativeRecoveryHandle,
  NativeSessionReadResult,
  NativeWorkerSessionBinding,
} from '@farmslot/protocol';

import { assertNativeParkSnapshot } from './worker-parking.js';

const handle: MachinePauseNativeRecoveryHandle = {
  version: 2,
  transport: 'native',
  runnerId: 'claude',
  contextId: 'primary',
  sessionId: 'conversation',
  nativeSessionId: 'host-session',
  executionNodeId: 'node',
  ownerPrincipalId: 'owner',
  leaseId: 'lease',
  generation: 'old',
  launchDigest: 'launch',
  slotId: 'slot',
  cwd: '/fixture',
  model: 'sonnet',
  capturedAt: '2026-09-14T00:00:00.000Z',
};
const binding: NativeWorkerSessionBinding = {
  sessionId: handle.nativeSessionId,
  leaseId: handle.leaseId,
  commandId: 'initial',
  executionNodeId: handle.executionNodeId,
  ownerPrincipalId: handle.ownerPrincipalId,
  generation: handle.generation,
};
function read(generation = 'old'): NativeSessionReadResult {
  return {
    session: {
      id: handle.nativeSessionId,
      nativeSessionId: handle.sessionId,
      generation,
      workerLeaseId: handle.leaseId,
      executionNodeId: handle.executionNodeId,
      ownerPrincipalId: handle.ownerPrincipalId,
      cwd: handle.cwd,
      state: 'idle',
    },
    commands: [],
  } as unknown as NativeSessionReadResult;
}
const input = { status: 'paused' as const, handle, binding, commandId: 'park-command' };

test('native parking refuses changed owner, lease, node, conversation or cwd', () => {
  assert.doesNotThrow(() => assertNativeParkSnapshot({ ...input, snapshot: read() }));
  for (const field of [
    'id',
    'nativeSessionId',
    'workerLeaseId',
    'executionNodeId',
    'ownerPrincipalId',
    'cwd',
  ] as const) {
    const snapshot = read();
    snapshot.session[field] = 'different';
    assert.throws(() => assertNativeParkSnapshot({ ...input, snapshot }), /identity changed/);
  }
});

test('native parking generation adoption requires its exact durable recovery intent or accepted receipt', () => {
  const snapshot = read('next');
  assert.throws(() => assertNativeParkSnapshot({ ...input, snapshot }), /identity changed/);
  assert.doesNotThrow(() =>
    assertNativeParkSnapshot({
      ...input,
      snapshot,
      binding: { ...binding, recovery: { fromGeneration: 'old', commandId: 'park-command' } },
    }),
  );
  for (const recovery of [
    { fromGeneration: 'old', commandId: 'unrelated' },
    { fromGeneration: 'unrelated', commandId: 'park-command' },
  ])
    assert.throws(
      () => assertNativeParkSnapshot({ ...input, snapshot, binding: { ...binding, recovery } }),
      /identity changed/,
    );
  snapshot.commands = [
    { commandId: 'park-command', accepted: true },
  ] as NativeSessionReadResult['commands'];
  assert.throws(() => assertNativeParkSnapshot({ ...input, snapshot }), /identity changed/);
  assert.doesNotThrow(() =>
    assertNativeParkSnapshot({ ...input, snapshot, binding: { ...binding, generation: 'next' } }),
  );
  snapshot.commands[0]!.accepted = false;
  assert.throws(
    () =>
      assertNativeParkSnapshot({ ...input, snapshot, binding: { ...binding, generation: 'next' } }),
    /identity changed/,
  );
});

test('cancelled resume cleanup remains observable without authorizing a new live generation', () => {
  const snapshot = read('next');
  const cancelled = {
    ...input,
    status: 'cancelled' as const,
    binding: { ...binding, generation: 'next' },
    snapshot,
  };
  assert.throws(() => assertNativeParkSnapshot(cancelled), /identity changed/);
  snapshot.session.state = 'closed';
  assert.throws(() => assertNativeParkSnapshot(cancelled), /identity changed/);
  snapshot.session.processStopped = true;
  assert.doesNotThrow(() => assertNativeParkSnapshot(cancelled));
  assert.throws(
    () => assertNativeParkSnapshot({ ...cancelled, status: 'paused' }),
    /identity changed/,
  );
});

test('relocation observes only the stopped source generation until its fenced successor starts', () => {
  const moved = {
    ...handle,
    slotId: 'other-slot',
    cwd: '/other',
    relocation: { fromSlotId: handle.slotId, fromCwd: handle.cwd },
  };
  const snapshot = read();
  const check = () => assertNativeParkSnapshot({ ...input, handle: moved, snapshot });
  assert.throws(check, /identity changed/);
  snapshot.session.state = 'closed';
  snapshot.session.processStopped = true;
  assert.doesNotThrow(check);
  snapshot.session.generation = 'unowned';
  assert.throws(check, /identity changed/);
  snapshot.session.generation = handle.generation;
  snapshot.session.cwd = '/unrelated';
  assert.throws(check, /identity changed/);
});
