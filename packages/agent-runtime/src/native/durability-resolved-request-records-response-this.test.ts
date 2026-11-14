import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { type NativeSessionEvent, type NativeSessionInfo } from '@farmslot/protocol';

import { setup, until } from './durability.test-support.js';
import { decodeRequest } from './ipc.js';
import { NativeSessionManager } from './manager.js';
import { appendDurable } from './storage.js';
import { NATIVE_WORKER_CANCEL_COMMAND } from './worker-launch.js';

test('a resolved request records the response this host delivered, and none for a runner resolution', async () => {
  const fixture = setup();
  const manager = new NativeSessionManager(fixture.root);
  try {
    const session = await manager.create('owner', { runner: 'codex', cwd: fixture.cwd });
    await manager.send('owner', session.id, 'delivered', 'approval');
    await until(() => manager.read('owner', session.id).pendingRequests.length === 1);
    const delivered = manager.read('owner', session.id).pendingRequests[0]!.request!.id;
    await manager.respond('owner', session.id, delivered, { decision: 'deny' });
    await until(() => manager.read('owner', session.id).session.state === 'idle');
    await manager.send('owner', session.id, 'runner', 'self-resolved');
    await until(() =>
      manager
        .read('owner', session.id, 0, 500)
        .events.some((event) => event.type === 'turn.completed' && event.commandId === 'runner'),
    );
    const resolved = (events: NativeSessionEvent[]) =>
      events
        .filter((event) => event.type === 'approval.resolved')
        .map((event) => [event.request?.title, event.response]);
    const expected = [
      ['Allow runner action?', { decision: 'deny' }],
      ['Allow runner action?', undefined],
    ];
    assert.deepEqual(resolved(manager.read('owner', session.id, 0, 500).events), expected);
    const journal = readFileSync(join(fixture.root, `${session.id}.journal`), 'utf8')
      .trim()
      .split('\n')
      .flatMap((line) => {
        const event = (JSON.parse(line) as { event?: NativeSessionEvent }).event;
        return event ? [event] : [];
      });
    assert.deepEqual(resolved(journal), expected);
  } finally {
    for (const session of manager.list('owner')) await manager.close('owner', session.id);
    fixture.restore();
  }
});

test('host IPC decodes a queued command removal, leased for a worker', () => {
  const removal = { owner: 'owner', id: 'session', commandId: 'queued' };
  assert.deepEqual(decodeRequest({ method: 'cancelCommand', ...removal, text: 'ignored' }), {
    method: 'cancelCommand',
    ...removal,
  });
  assert.throws(
    () => decodeRequest({ method: 'cancelCommand', owner: 'owner', id: 'session' }),
    /Invalid IPC commandId/,
  );
  const lease = { generation: 'generation', leaseId: 'lease' };
  assert.deepEqual(decodeRequest({ method: NATIVE_WORKER_CANCEL_COMMAND, ...removal, ...lease }), {
    method: NATIVE_WORKER_CANCEL_COMMAND,
    ...removal,
    ...lease,
  });
  assert.throws(
    () => decodeRequest({ method: NATIVE_WORKER_CANCEL_COMMAND, ...removal, leaseId: 'lease' }),
    /Invalid IPC generation/,
  );
});

test('a queued command is removed durably, once, and only while it waits in its lease', () => {
  const root = mkdtempSync(join(tmpdir(), 'native-cancel-'));
  const info: NativeSessionInfo = {
    id: 'session',
    generation: 'generation',
    hostPid: process.pid,
    runner: 'codex',
    nativeSessionId: 'conversation',
    ownerPrincipalId: 'owner',
    executionNodeId: 'local',
    accountContextId: 'account',
    cwd: root,
    executable: 'codex',
    version: 'fixture',
    mode: 'default',
    accountMode: 'native',
    workerManaged: true,
    workerLeaseId: 'lease',
    state: 'failed',
    capabilities: {
      modes: ['default'],
      streaming: true,
      tools: true,
      approvals: true,
      questions: false,
      interrupt: true,
      resume: true,
    },
  };
  const command = (commandId: string, fields: object = {}) => ({
    commandId,
    text: commandId,
    generation: 'generation',
    leaseId: 'lease',
    state: 'pending',
    queued: true,
    submitted: false,
    accepted: false,
    ...fields,
  });
  try {
    appendDurable(join(root, 'session.journal'), {
      info,
      context: {},
      commands: [
        command('queued'),
        command('submitted', { state: 'unknown', queued: false, submitted: true }),
        command('interrupted', { state: 'failed', queued: false, outcome: 'interrupted' }),
        command('other-lease', { leaseId: 'previous' }),
        command('other-generation', { generation: 'previous' }),
      ],
    });
    const manager = new NativeSessionManager(root);
    assert.equal(manager.read('owner', info.id).session.capabilities.cancelQueued, true);
    const removed = manager.cancelCommand('owner', info.id, 'queued');
    assert.deepEqual(removed, {
      commandId: 'queued',
      generation: 'generation',
      state: 'failed',
      queued: false,
      submitted: false,
      accepted: false,
      outcome: 'cancelled',
    });
    // Persisted before the reply, and a repeated call returns the same receipt.
    const reloaded = new NativeSessionManager(root);
    assert.deepEqual(reloaded.cancelCommand('owner', info.id, 'queued'), removed);
    for (const [commandId, refusal] of [
      ['submitted', /no longer queued/],
      ['interrupted', /no longer queued/],
      ['other-lease', /different generation or worker lease/],
      ['other-generation', /different generation or worker lease/],
      ['unsent', /unknown to this session/],
    ] as const)
      assert.throws(() => reloaded.cancelCommand('owner', info.id, commandId), refusal);
    assert.throws(() => reloaded.cancelCommand('another-owner', info.id, 'queued'), /not found/);
    assert.equal(
      new NativeSessionManager(root)
        .read('owner', info.id)
        .commands.find((receipt) => receipt.commandId === 'other-lease')?.queued,
      true,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
