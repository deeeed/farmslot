import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import type { AgentContext } from '@farmslot/protocol';

import '../../runtime/mock-pty.test-support.js';

import { createRun, deleteRun, getRun, updateRun } from '../../runs/store.js';

const lifecycle = await import('./lifecycle-control.js');
let released = false;
mock.module('./lifecycle-control.js', {
  namedExports: {
    ...lifecycle,
    releaseCompletedRunSlot: async () => ({
      released,
      skipped: released ? undefined : 'worker alive',
    }),
  },
});
const { runInteractiveDevResolve } = await import('../run.js');

for (const action of ['done-no-pr', 'failed'] as const) {
  for (const cleanupSucceeded of [false, true]) {
    test(`${action} retains exact legacy context until cleanup succeeds=${cleanupSucceeded}`, async (t) => {
      released = cleanupSucceeded;
      const run = createRun({
        project: 'interactive-cleanup',
        flowType: 'dev',
        mode: 'interactive',
        ticketOrPr: 'OWNER-123',
      });
      t.after(async () => {
        if (getRun(run.id)) {
          updateRun(run.id, { status: 'cancelled', slotId: null });
          await deleteRun(run.id);
        }
      });
      const context: AgentContext = {
        id: 'dev',
        role: 'dev',
        label: 'Worker',
        status: 'working',
        runId: run.id,
        slotId: 'retained-slot',
        runner: 'claude',
        runnerSessionId: 'retained-session',
        runnerSessionPath: '/sessions/retained.jsonl',
        target: {
          session: 'reused',
          window: 'dev',
          pane: '1',
          paneId: '%383',
          target: 'reused:dev',
        },
      };
      updateRun(run.id, {
        status: 'monitoring',
        slotId: 'retained-slot',
        agentContexts: [context],
      });
      const result = await runInteractiveDevResolve({ runId: run.id, action }, () => {});
      assert.equal(result.ok, true);
      assert.equal(getRun(run.id)?.status, action === 'done-no-pr' ? 'done' : 'failed');
      const retained = getRun(run.id)?.agentContexts ?? [];
      if (cleanupSucceeded) assert.deepEqual(retained, []);
      else {
        assert.equal(retained.length, 1);
        assert.deepEqual(retained[0].target, context.target);
        assert.equal(retained[0].runner, context.runner);
        assert.equal(retained[0].runnerSessionId, context.runnerSessionId);
        assert.equal(retained[0].runnerSessionPath, context.runnerSessionPath);
        assert.equal(retained[0].slotId, context.slotId);
      }
    });
  }
}
