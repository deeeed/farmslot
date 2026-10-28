import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { NativeSessionInfo } from '@farmslot/protocol';

import { NativeSessionManager } from './manager.js';

for (const reconcile of ['control', 'expired observation'] as const) {
  test(`read APIs cache metadata and reconcile a reused PID through ${reconcile}`, (t) => {
    const root = mkdtempSync(join(tmpdir(), 'native-process-observations-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const pid = 100038100;
    let observedBirth = 'original birth';
    let now = 100_000;
    t.mock.method(Date, 'now', () => now);
    let reads = 0;
    t.mock.method(childProcess, 'execFileSync', () => {
      reads++;
      return observedBirth;
    });
    syncBuiltinESMExports();
    t.after(() => {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    });
    t.mock.method(process, 'kill', (requested: number, signal?: NodeJS.Signals | number) => {
      assert.equal(Math.abs(requested), pid);
      assert.equal(
        signal,
        0,
        'A passive read or stopped confirmation must not signal the replacement',
      );
      return true;
    });
    const info: NativeSessionInfo = {
      id: 'retained',
      generation: 'generation',
      hostPid: process.pid,
      processPid: pid,
      processStopped: false,
      processIdentity: 'fixture-marker',
      runner: 'fixture',
      nativeSessionId: 'conversation',
      ownerPrincipalId: 'owner',
      executionNodeId: 'local',
      accountContextId: 'account',
      cwd: root,
      executable: process.execPath,
      version: process.version,
      mode: 'default',
      accountMode: 'native',
      workerManaged: true,
      workerLeaseId: 'lease',
      state: 'failed',
      capabilities: {
        modes: ['default'],
        streaming: false,
        tools: false,
        approvals: false,
        questions: false,
        interrupt: false,
        resume: false,
      },
    };
    writeFileSync(
      join(root, 'retained.journal'),
      JSON.stringify({
        info,
        context: {},
        processes: [{ pid, parent: 1, group: pid, identity: observedBirth }],
      }) + '\n',
      { mode: 0o600 },
    );
    const manager = new NativeSessionManager(root);
    assert.equal(manager.list('owner').length, 1);
    manager.read('owner', info.id);
    manager.readWorker('owner', info.id, 'lease');
    assert.equal(reads, 1);
    observedBirth = 'replacement birth';
    assert.equal(manager.read('owner', info.id).session.processStopped, false);
    assert.equal(reads, 1);
    if (reconcile === 'control') {
      manager.assertWorkerLease('owner', info.id, info.generation, 'lease', true);
    } else {
      now += 60_000;
    }
    assert.equal(manager.read('owner', info.id).session.processStopped, true);
    assert.ok(reads > 1, 'A control or expired observation must read fresh metadata');
  });
}
