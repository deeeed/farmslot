import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CopilotRuntimeController } from './controller.js';
import { COPILOT_TMUX_SESSION } from './launcher.js';
import { CopilotRuntimeStore } from './session-store.js';
import { FakeCopilotTmux, testController, testWorkload } from './test-helpers.js';

test('first start creates one canonical runner and later starts reuse it across conversations', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'copilot-lifecycle-'));
  const { controller, tmux } = testController({ home, checkout: process.cwd() });
  const first = await controller.start({ runner: 'cursor', model: 'test-model' });
  await controller.send({ sessionId: 'manual:alternate', message: 'same runtime' });
  const second = await controller.start({ mode: 'reconnect' });
  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  assert.equal(second.session.runtimeId, first.session.runtimeId);
  assert.equal(second.session.transcriptId, 'manual:alternate');
  assert.equal(tmux.launchCount, 1);
  await controller.stop({ reason: 'test-complete' });
});

test('restart reconciliation reattaches the exact persisted canonical target', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'copilot-reconcile-'));
  const tmux = new FakeCopilotTmux();
  const first = testController({ home, checkout: process.cwd(), tmux }).controller;
  const started = await first.start({ runner: 'cursor', model: 'test-model' });
  const restarted = testController({ home, checkout: process.cwd(), tmux }).controller;
  await restarted.initialize();
  const status = await restarted.status();
  assert.equal(status.session.status, 'running');
  assert.equal(status.session.runtimeId, started.session.runtimeId);
  assert.ok(status.session.reconnectedAt);
  assert.equal(tmux.launchCount, 1);
  await restarted.stop({ reason: 'restart-test-complete' });
});

test('ambiguous restart reconciliation fails closed', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'copilot-ambiguous-'));
  const tmux = new FakeCopilotTmux();
  tmux.sessions.add(COPILOT_TMUX_SESSION);
  tmux.sessions.add(`${COPILOT_TMUX_SESSION}-orphan`);
  const controller = new CopilotRuntimeController({
    store: new CopilotRuntimeStore(home),
    tmux,
    checkout: process.cwd(),
    inspectCheckout: async () => ({
      path: process.cwd(),
      branch: 'feat/test',
      head: 'abc',
      dirtyFileCount: 0,
      dirtyPaths: [],
    }),
    workload: testWorkload,
  });
  await controller.initialize();
  assert.equal((await controller.status()).session.status, 'ambiguous');
  await assert.rejects(() => controller.start(), /Ambiguous Co-Pilot tmux sessions/);
  assert.equal(tmux.killCount, 0);
});

test('stop records an explicit terminal reason', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'copilot-stop-'));
  const { controller } = testController({ home, checkout: process.cwd() });
  await controller.start({ runner: 'cursor', model: 'test-model' });
  const stopped = await controller.stop({ reason: 'operator-requested' });
  assert.equal(stopped.session.status, 'stopped');
  assert.equal(stopped.session.terminalReason, 'operator-requested');
});

test('hook-driven runners remain starting until bootstrap delivery is proven', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'copilot-bootstrap-state-'));
  let settleDelivery: ((accepted: boolean) => void) | undefined;
  const delivery = new Promise<boolean>((resolve) => {
    settleDelivery = resolve;
  });
  const { controller } = testController({
    home,
    checkout: process.cwd(),
    sendInstruction: async () => delivery,
  });
  const starting = controller.start({ runner: 'claude', model: 'opus' });
  while (controller.currentSession()?.status !== 'starting') {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.equal(controller.currentSession()?.status, 'starting');
  settleDelivery?.(true);
  assert.equal((await starting).session.status, 'running');
  await controller.stop({ reason: 'bootstrap-state-test' });
});
