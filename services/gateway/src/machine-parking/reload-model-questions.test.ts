import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import type { AgentContext, MachinePauseTerminalRecoveryHandle } from '@farmslot/protocol';

await import('../runtime/mock-pty.test-support.js');
const config = await import('../core/config.js');
const tmux = await import('../core/tmux.js');
const lifecycle = await import('../runners/session-lifecycle.js');
const { makeVars } = await import('../runners/test-fixtures.js');
const { buildRunnerSessionReloadCommand } = await import('../runners/launch-command.js');
const { makeRun } = await import('../run-engine/test-fixtures.js');
mock.module('../core/config.js', {
  namedExports: { ...config, loadSlotVars: async () => makeVars({ slotId: 'slot' }) },
});
mock.module('../core/tmux.js', {
  namedExports: { ...tmux, resolveTmuxSession: async () => slotSession },
});
let slotSession = 'slot';
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
    const reload = reloads.at(-1);
    assert.equal(reload?.modelQuestions, mode === 'autonomous' ? 'off' : undefined);
    assert.ok(reload?.beforeRespawn);
    await reload.beforeRespawn();
    slotSession = 'successor';
    await assert.rejects(async () => reload.beforeRespawn?.(), /slot session changed/);
    slotSession = 'slot';
  }
});

function parkedContext(runId: string, role: AgentContext['role']): AgentContext {
  return {
    id: 'primary',
    role,
    label: role,
    status: 'working',
    slotId: 'slot',
    runId,
  };
}

test('a parked pi reload uses high thinking when effort is empty', async () => {
  const run = makeRun({
    id: 'parked-review',
    slotId: 'slot',
    flowType: 'review-pr',
    mode: 'autonomous',
  });
  run.agentContexts = [parkedContext(run.id, 'review')];
  const piHandle: MachinePauseTerminalRecoveryHandle = {
    ...handle,
    runnerId: 'pi',
    model: 'grok-4.7',
  };
  const commandFor = (recovery: (typeof reloads)[number] | undefined, sessionId: string) =>
    buildRunnerSessionReloadCommand(
      makeVars({ piPath: 'pi', slotId: 'slot' }),
      'pi',
      'grok-4.7',
      sessionId,
      { effort: recovery?.recoveryHandle.effort },
    );
  await assert.rejects(defaultReloadRunner(run, piHandle, 'Continue'), /fixture stops/);
  const reload = reloads.at(-1);
  assert.equal(reload?.recoveryHandle.effort, undefined);
  assert.match(commandFor(reload, piHandle.sessionId), /--thinking high/);

  run.agentContexts = [parkedContext(run.id, 'dev')];
  await assert.rejects(defaultReloadRunner(run, piHandle, 'Continue'), /fixture stops/);
  assert.match(commandFor(reloads.at(-1), piHandle.sessionId), /--thinking high/);

  const kept: MachinePauseTerminalRecoveryHandle = { ...piHandle, effort: 'low' };
  run.agentContexts = [parkedContext(run.id, 'review')];
  await assert.rejects(defaultReloadRunner(run, kept, 'Continue'), /fixture stops/);
  const explicit = reloads.at(-1);
  assert.equal(explicit?.recoveryHandle.effort, 'low');
  assert.match(commandFor(explicit, kept.sessionId), /--thinking low/);

  const raised: MachinePauseTerminalRecoveryHandle = { ...piHandle, effort: 'xhigh' };
  await assert.rejects(defaultReloadRunner(run, raised, 'Continue'), /fixture stops/);
  const selected = reloads.at(-1);
  assert.equal(selected?.recoveryHandle.effort, 'xhigh');
  assert.match(commandFor(selected, raised.sessionId), /--thinking xhigh/);
});
