import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { setup } from './durability.test-support.js';
import { NativeSessionManager } from './manager.js';
import { type NativeWorkerLaunch } from './worker-launch.js';

type QuestionModeTransfer = readonly ['on', 'off'] | readonly ['off', 'on'];

export function registerQuestionModeTransfer(variant: QuestionModeTransfer) {
  const [from, to] = variant;
  test(`a retained native worker changes question tools from ${from} to ${to} only after stop and resume`, async () => {
    const fixture = setup();
    const manager = new NativeSessionManager(fixture.root);
    const launch: NativeWorkerLaunch = {
      leaseId: randomUUID(),
      executable: './codex',
      safetyTier: 'full-auto',
      modelQuestions: from === 'off' ? 'off' : undefined,
      environment: { set: {}, unset: [] },
    };
    try {
      const session = await manager.ensure(
        'owner',
        {
          sessionId: randomUUID(),
          runner: 'codex',
          cwd: fixture.cwd,
        },
        launch,
      );
      const next = {
        ...launch,
        leaseId: randomUUID(),
        modelQuestions: to === 'off' ? ('off' as const) : undefined,
      };
      assert.equal(session.workerModelQuestions, from);
      assert.throws(
        () => manager.transferWorker('owner', session.id, session.generation, launch.leaseId, next),
        /question tool changed/,
      );
      await manager.closeWorker('owner', session.id, session.generation, launch.leaseId);
      const restored = new NativeSessionManager(fixture.root);
      assert.equal(restored.read('owner', session.id).session.workerModelQuestions, from);
      restored.transferWorker('owner', session.id, session.generation, launch.leaseId, next);
      try {
        const resumed = await restored.resumeWorker(
          'owner',
          {
            sessionId: session.id,
            resumeSessionId: session.nativeSessionId,
            generation: session.generation,
            commandId: randomUUID(),
            runner: 'codex',
            cwd: fixture.cwd,
          },
          next,
        );
        assert.equal(resumed.workerModelQuestions, to);
        assert.notEqual(resumed.generation, session.generation);
        assert.equal(resumed.nativeSessionId, session.nativeSessionId);
      } finally {
        for (const info of restored.list('owner')) await restored.close('owner', info.id);
      }
    } finally {
      for (const session of manager.list('owner')) await manager.close('owner', session.id);
      fixture.restore();
    }
  });
}
