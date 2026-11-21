import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import test from 'node:test';

import { setup } from './durability.test-support.js';
import { NativeSessionManager } from './manager.js';
import { nativeRunnerDefinitions } from './registry.js';
import type { NativeAdapterOptions, NativeEventInput } from './types.js';

test('an exited worker with retained handles can confirm stop and cancel its exact lease', async (t) => {
  const fixture = setup();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    fixture.restore();
  });
  const leader = 100038100;
  const child = 100038101;
  const birth = 'recorded process birth';
  let publish: ((event: NativeEventInput) => void) | undefined;
  t.mock.method(
    nativeRunnerDefinitions.codex.adapter,
    'start',
    async (options: NativeAdapterOptions, emit: (event: NativeEventInput) => void) => {
      publish = emit;
      options.onSpawn?.(leader, 'fixture-process');
      options.onProcessSnapshot?.([
        { pid: leader, parent: process.pid, group: leader, identity: birth },
        { pid: child, parent: leader, group: child, identity: birth },
      ]);
      return {
        nativeSessionId: 'retained-conversation',
        send: async () => assert.fail('unexpected native send'),
        respond: async () => assert.fail('unexpected native response'),
        interrupt: async () => assert.fail('unexpected native interrupt'),
        close: async () => assert.fail('unexpected native close'),
      };
    },
  );
  const manager = new NativeSessionManager(fixture.root);
  const leaseId = randomUUID();
  const { id, generation } = await manager.create(
    'owner',
    { runner: 'codex', cwd: fixture.cwd },
    {
      leaseId,
      safetyTier: 'full-auto',
      executable: join(fixture.cwd, 'codex'),
      environment: { set: {}, unset: [] },
    },
  );
  assert.ok(publish);

  let livePid: number | undefined;
  let groupAlive = false;
  let unreadable = false;
  t.mock.method(process, 'kill', (pid: number, signal?: NodeJS.Signals | number) => {
    assert.equal(signal, 0, 'Stop confirmation may only probe processes');
    if (pid !== livePid && !(pid === -leader && groupAlive))
      throw Object.assign(new Error('No such fixture process'), { code: 'ESRCH' });
    return true;
  });
  t.mock.method(childProcess, 'execFileSync', (file: string, args: string[]) => {
    assert.equal(file, 'ps');
    assert.deepEqual(args, ['-p', String(livePid), '-o', 'lstart=']);
    if (unreadable)
      throw Object.assign(new Error('Fixture census timed out'), { code: 'ETIMEDOUT' });
    return birth;
  });
  syncBuiltinESMExports();
  const confirm = () => manager.confirmWorkerStopped('owner', id, generation, leaseId);
  const absent = /requires an absent native process and process group/;
  const closed = (exitCode: number | null) =>
    ({
      type: 'session.closed',
      status: 'failed',
      data: {
        exitCode,
        signal: null,
        processStopped: false,
        error: 'Census failed during cleanup',
      },
    }) satisfies NativeEventInput;
  assert.throws(confirm, absent);
  publish(closed(null));
  assert.throws(confirm, absent);
  publish(closed(0));
  await assert.rejects(
    manager.cancelWorker('owner', id, leaseId, generation),
    /cleanup is unconfirmed/,
  );
  assert.throws(
    () => manager.confirmWorkerStopped('foreign', id, generation, leaseId),
    /not found/,
  );
  assert.throws(
    () => manager.confirmWorkerStopped('owner', id, 'stale', leaseId),
    /generation or task lease changed/,
  );
  assert.throws(
    () => manager.confirmWorkerStopped('owner', id, generation, 'stale'),
    /generation or task lease changed/,
  );
  await t.test('surviving processes and unavailable census evidence block cleanup', () => {
    livePid = leader;
    assert.throws(confirm, absent);
    livePid = undefined;
    groupAlive = true;
    assert.throws(confirm, absent);
    groupAlive = false;
    livePid = child;
    assert.throws(confirm, /observed native descendant is still alive/);
    unreadable = true;
    assert.throws(confirm, /Fixture census timed out/);
    assert.equal(manager.inspect('owner', id).processStopped, false);
  });

  livePid = undefined;
  const confirmed = confirm();
  assert.equal(confirmed.processStopped, true);
  assert.equal(confirmed.processStopReason, 'process-missing-attested');
  const cancelled = await manager.cancelWorker('owner', id, leaseId, generation);
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.session?.nativeSessionId, 'retained-conversation');
  const restored = new NativeSessionManager(fixture.root).inspect('owner', id);
  assert.equal(restored.processStopped, true);
  assert.equal(restored.generation, generation);
  assert.equal(restored.workerLeaseId, leaseId);
});
