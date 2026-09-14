import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type {
  NativeCommandReceipt,
  NativeSessionEvent,
  NativeSessionInfo,
} from '@farmslot/protocol';

import type { NativeSessionClient } from './client.js';
import { NativeSessionManager } from './manager.js';
import { routeNativeSession } from './service.js';
import { NativeWorkerHistory } from './worker-history.js';
import { type NativeWorkerLaunch, nativeWorkerLaunchDigest } from './worker-launch.js';

const info: NativeSessionInfo = {
  id: randomUUID(),
  generation: 'generation',
  hostPid: 123,
  runner: 'codex',
  nativeSessionId: 'conversation',
  ownerPrincipalId: 'owner',
  executionNodeId: 'local',
  accountContextId: 'account',
  cwd: '/tmp',
  executable: '/bin/false',
  version: '1',
  mode: 'default',
  accountMode: 'native',
  workerManaged: true,
  workerLeaseId: randomUUID(),
  state: 'closed',
  processStopped: true,
  capabilities: {
    modes: ['default'],
    streaming: true,
    tools: true,
    approvals: true,
    questions: true,
    interrupt: true,
    resume: true,
  },
};
const receipt = (id: string): NativeCommandReceipt => ({
  generation: 'generation',
  commandId: id,
  state: 'completed',
  submitted: true,
  accepted: true,
});
const event = (sequence: number, commandId: string): NativeSessionEvent => ({
  sessionId: info.id,
  sequence,
  generation: info.generation,
  at: 'now',
  type: 'command.submitted',
  commandId,
  text: commandId,
});

test('scoped task history preserves version-based recovery restrictions', () => {
  for (const version of ['2.1.78 (Claude Code)', '2.1.269 (Claude Code)']) {
    const root = mkdtempSync(join(tmpdir(), 'native-history-version-'));
    try {
      const saved = { ...info, runner: 'claude', version };
      writeFileSync(
        join(root, `${info.id}.journal`),
        JSON.stringify({ info: saved, context: {} }) + '\n',
      );
      const manager = new NativeSessionManager(root);
      const expected = manager.read('owner', info.id).session.capabilities;
      const actual = manager.readWorker('owner', info.id, info.workerLeaseId!).session.capabilities;
      assert.deepEqual(actual, expected);
      assert.equal(actual.resume, version.startsWith('2.1.269'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('lease windows freeze metadata and receipts, filter before last100, and keep absolute pagination', () => {
  const history = new NativeWorkerHistory();
  const first = info.workerLeaseId!;
  const next = randomUUID();
  history.observe({ info: { ...info, state: 'idle' } });
  const events = [event(1, 'original')];
  history.observe({ event: events[0], commands: [{ ...receipt('original'), state: 'unknown' }] });
  history.observe({ info: { ...info, workerLeaseId: next } });
  // A resumed successor can update global receipts without rewriting the prior task snapshot.
  history.observe({
    info: { ...info, workerLeaseId: next, generation: 'resumed' },
    commands: [receipt('original')],
  });
  for (let sequence = 2; sequence <= 105; sequence++) {
    events.push(event(sequence, `next-${sequence}`));
    history.observe({ event: events.at(-1), commands: [receipt(`next-${sequence}`)] });
  }
  const prior = history.read(first, events, [events[104]]);
  assert.deepEqual(prior.scope, { leaseId: first, startAfter: 0, endAt: 1, released: true });
  assert.equal(prior.session.state, 'idle', 'Task release is not process closure');
  assert.equal(prior.session.generation, 'generation');
  assert.deepEqual(prior.commands, [
    { ...receipt('original'), state: 'unknown', outcome: undefined },
  ]);
  assert.deepEqual(prior.pendingRequests, []);
  assert.deepEqual(prior.events, [events[0]]);
  const page = history.read(next, events, [], undefined, 2);
  assert.deepEqual(
    page.events.map((item) => item.sequence),
    [2, 3],
  );
  assert.equal(page.cursor, 3);
  assert.equal(page.hasMore, true);
  assert.equal(page.commands.length, 100);
  assert.equal(page.commands[0].commandId, 'next-6');
  assert.equal(page.session.generation, 'resumed');
  assert.throws(() => history.read(next, events, [], 0), /cursor/);
  assert.throws(() => history.read(first, events, [], 2), /cursor/);
  assert.throws(() => history.read('unknown', events, []), /unknown/);
});

test('both worker transfer and cancellation lease claim retain the same history across host reload', async () => {
  for (const cancellation of [false, true]) {
    const root = mkdtempSync(join(tmpdir(), 'native-history-'));
    try {
      const next = randomUUID();
      const launch: NativeWorkerLaunch = {
        leaseId: next,
        safetyTier: 'full-auto',
        environment: { set: {}, unset: [] },
      };
      writeFileSync(
        join(root, `${info.id}.journal`),
        JSON.stringify({
          info,
          context: { workerLaunchDigest: nativeWorkerLaunchDigest(launch) },
          event: event(1, 'original'),
          commands: [{ ...receipt('original'), text: 'private prompt' }],
        }) + '\n',
      );
      const manager = new NativeSessionManager(root);
      if (cancellation)
        await manager.cancelWorker('owner', info.id, next, info.generation, info.workerLeaseId);
      else manager.transferWorker('owner', info.id, info.generation, info.workerLeaseId!, launch);
      const expected = manager.readWorker('owner', info.id, info.workerLeaseId!);
      assert.equal(expected.scope?.released, true);
      assert.equal(expected.scope.endAt, 1);
      assert.equal(expected.commands.length, 1);
      assert.equal('text' in expected.commands[0], false);
      const loaded = new NativeSessionManager(root);
      assert.deepEqual(loaded.readWorker('owner', info.id, info.workerLeaseId!), expected);
      const successor = loaded.readWorker('owner', info.id, next);
      assert.deepEqual(successor.scope, {
        leaseId: next,
        startAfter: 1,
        endAt: 1,
        released: false,
      });
      assert.deepEqual(successor.events, []);
      assert.deepEqual(successor.commands, []);
      assert.throws(
        () => loaded.readWorker('other-owner', info.id, info.workerLeaseId!),
        /principal/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('worker workspace reads require a pin and refuse results when the lease transfers during the read', async () => {
  const root = mkdtempSync(join(tmpdir(), 'native-history-files-'));
  try {
    writeFileSync(join(root, 'file.txt'), 'task file');
    let calls = 0;
    let transfer = false;
    const client = {
      executionNodeId: 'local',
      async read() {
        calls++;
        return {
          session: {
            ...info,
            cwd: root,
            state: 'idle',
            workerLeaseId: transfer && calls > 1 ? 'successor' : info.workerLeaseId,
          },
        };
      },
    } as unknown as NativeSessionClient;
    const params = { sessionId: info.id, path: 'file.txt' };
    await assert.rejects(
      routeNativeSession(client, 'owner', 'native.session.workspace.read', params),
      /pinned/,
    );
    const pinned = {
      ...params,
      worker: {
        runId: 'run',
        contextId: 'context',
        generation: info.generation,
        leaseId: info.workerLeaseId,
      },
    };
    calls = 0;
    assert.deepEqual(
      await routeNativeSession(client, 'owner', 'native.session.workspace.read', pinned),
      { path: 'file.txt', content: 'task file' },
    );
    assert.equal(calls, 2);
    calls = 0;
    transfer = true;
    await assert.rejects(
      routeNativeSession(client, 'owner', 'native.session.workspace.read', pinned),
      /transferred/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
