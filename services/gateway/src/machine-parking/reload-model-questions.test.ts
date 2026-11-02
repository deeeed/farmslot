import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import type { MachinePauseTerminalRecoveryHandle } from '@farmslot/protocol';

await import('../runtime/mock-pty.test-support.js');
const config = await import('../core/config.js');
const tmux = await import('../core/tmux.js');
const lifecycle = await import('../runners/session-lifecycle.js');
const { makeVars } = await import('../runners/test-fixtures.js');
const { makeRun } = await import('../run-engine/test-fixtures.js');
mock.module('../core/config.js', {
  namedExports: { ...config, loadSlotVars: async () => makeVars({ slotId: 'slot' }) },
});
mock.module('../core/tmux.js', {
  namedExports: { ...tmux, resolveTmuxSession: async () => 'slot' },
});
const reloads: Parameters<typeof lifecycle.reloadRunnerForPark>[0][] = [];
mock.module('../runners/session-lifecycle.js', {
  namedExports: {
    ...lifecycle,
    reloadRunnerForPark: async (options: Parameters<typeof lifecycle.reloadRunnerForPark>[0]) => {
      reloads.push(options);
      return {
        ok: false,
        status: 'failed',
        runnerId: 'codex',
        target: '%1',
        sessionId: 'session',
        error: 'fixture stops after the reload request',
      } satisfies Awaited<ReturnType<typeof lifecycle.reloadRunnerForPark>>;
    },
  },
});
const { defaultReloadRunner } = await import('./service.js');

const handle: MachinePauseTerminalRecoveryHandle = {
  version: 1,
  runnerId: 'codex',
  contextId: 'primary',
  sessionId: 'session',
  sessionPath: '/sessions/session.jsonl',
  target: { session: 'slot', window: 'worker', paneId: '%1', target: 'slot:worker' },
  model: 'gpt-6-astra',
  capturedAt: '2026-11-02T00:00:00.000Z',
};

test("a parked tmux worker reloads with its run mode's question tool", async () => {
  for (const mode of ['autonomous', 'interactive'] as const) {
    const run = makeRun({ id: 'parked', slotId: 'slot', mode, agentContexts: [] });
    await assert.rejects(defaultReloadRunner(run, handle, 'Continue'), /fixture stops/);
    assert.equal(reloads.at(-1)?.modelQuestions, mode === 'autonomous' ? 'off' : undefined);
  }
});
