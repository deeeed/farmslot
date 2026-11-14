import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { setup, until } from './durability.test-support.js';
import { NativeSessionManager } from './manager.js';
import { type NativeWorkerLaunch } from './worker-launch.js';

type ResumeProbeRace = 'cancel' | 'transfer';

export function registerResumeProbeRace(variant: ResumeProbeRace) {
  const race = variant;
  test(`worker resume rechecks ${race} after its asynchronous executable probe`, async () => {
    const fixture = setup();
    const manager = new NativeSessionManager(fixture.root);
    const launch: NativeWorkerLaunch = {
      leaseId: randomUUID(),
      executable: join(fixture.cwd, 'codex'),
      safetyTier: 'sandboxed',
      environment: { set: {}, unset: [] },
    };
    let pending: Promise<unknown> | undefined;
    try {
      const first = await manager.ensure(
        'owner',
        { sessionId: randomUUID(), runner: 'codex', cwd: fixture.cwd },
        launch,
      );
      await manager.closeWorker('owner', first.id, first.generation, launch.leaseId);
      const startReceipt = readFileSync(join(fixture.cwd, 'native-start.json'), 'utf8');
      const binary = readFileSync(launch.executable!, 'utf8');
      writeFileSync(
        launch.executable!,
        binary.replace(
          "if (process.argv.includes('--version')) {",
          `if (process.argv.includes('--version')) {
        const probeFs = require('node:fs');
        probeFs.writeFileSync('version-entered', '');
        while (!probeFs.existsSync('version-release')) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      `,
        ),
      );
      const commandId = randomUUID();
      pending = manager.resumeWorker(
        'owner',
        {
          sessionId: first.id,
          generation: first.generation,
          runner: 'codex',
          cwd: fixture.cwd,
          resumeSessionId: first.nativeSessionId,
          commandId,
        },
        launch,
      );
      const rejected = assert.rejects(
        pending,
        race === 'cancel' ? /operation was cancelled/ : /lease changed/,
      );
      await until(() => existsSync(join(fixture.cwd, 'version-entered')));
      if (race === 'cancel')
        await manager.cancelWorker(
          'owner',
          first.id,
          launch.leaseId,
          first.generation,
          undefined,
          commandId,
        );
      else
        manager.transferWorker('owner', first.id, first.generation, launch.leaseId, {
          ...launch,
          leaseId: randomUUID(),
        });
      writeFileSync(join(fixture.cwd, 'version-release'), '');
      await rejected;
      const after = manager.read('owner', first.id).session;
      assert.equal(after.generation, first.generation);
      assert.equal(after.processStopped, true);
      assert.equal(readFileSync(join(fixture.cwd, 'native-start.json'), 'utf8'), startReceipt);
    } finally {
      writeFileSync(join(fixture.cwd, 'version-release'), '');
      if (pending) await Promise.allSettled([pending]);
      for (const session of manager.list('owner')) await manager.close('owner', session.id);
      fixture.restore();
    }
  });
}
