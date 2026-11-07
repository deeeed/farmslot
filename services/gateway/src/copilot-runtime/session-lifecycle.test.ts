import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CopilotRuntimeController } from './controller.js';
import { COPILOT_TMUX_SESSION } from './launcher.js';
import { CopilotRuntimeStore } from './session-store.js';
import {
  FakeCopilotNative,
  FakeCopilotTmux,
  testController,
  testWorkload,
} from './test-helpers.js';

test('first start creates one canonical runner and later starts reuse it across conversations', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'copilot-lifecycle-'));
  const { controller, native } = testController({ home, checkout: process.cwd() });
  const first = await controller.start({ runner: 'cursor', model: 'test-model' });
  const second = await controller.start({ mode: 'reconnect' });
  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  assert.equal(second.session.runtimeId, first.session.runtimeId);
  assert.equal(second.session.nativeSession?.sessionId, first.session.nativeSession?.sessionId);
  assert.equal(native.launches, 1);
  assert.equal(native.sends.size, 1, 'Reopening does not replay the bootstrap');
  await controller.stop({ reason: 'test-complete' });
});

test('restart reconciliation reattaches the exact persisted canonical target', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'copilot-reconcile-'));
  const native = new FakeCopilotNative();
  const first = testController({ home, checkout: process.cwd(), native }).controller;
  const started = await first.start({ runner: 'cursor', model: 'test-model' });
  await first.dispose();
  const restarted = testController({ home, checkout: process.cwd(), native }).controller;
  await restarted.initialize();
  const status = await restarted.status();
  assert.equal(status.session.status, 'running');
  assert.equal(status.session.runtimeId, started.session.runtimeId);
  assert.equal(status.session.nativeSession?.sessionId, started.session.nativeSession?.sessionId);
  assert.equal(native.launches, 1);
  await restarted.stop({ reason: 'restart-test-complete' });
});

test('ambiguous restart reconciliation fails closed', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'copilot-ambiguous-'));
  const tmux = new FakeCopilotTmux();
  tmux.sessions.add(COPILOT_TMUX_SESSION);
  tmux.sessions.add(`${COPILOT_TMUX_SESSION}-orphan`);
  const controller = new CopilotRuntimeController({
    store: new CopilotRuntimeStore(home),
    observeCheckout: async () => async () => {},
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
  await assert.rejects(() => controller.start(), /legacy Co-Pilot terminal/);
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

test('status throttles passive native metadata reads', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'copilot-status-throttle-'));
  let nowMs = Date.parse('2026-08-14T00:00:00Z');
  const { controller, native } = testController({
    home,
    checkout: process.cwd(),
    now: () => new Date(nowMs),
  });
  await controller.start({ runner: 'cursor', model: 'test-model' });
  const afterStart = native.inspections;
  await controller.status();
  await controller.status();
  assert.equal(native.inspections, afterStart);
  nowMs += 5_001;
  await controller.status();
  assert.equal(native.inspections, afterStart + 1);
  await controller.stop({ reason: 'status-throttle-test' });
});

test('native launch stays starting until its structured bootstrap acceptance is confirmed', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'copilot-bootstrap-state-'));
  const native = new FakeCopilotNative();
  let release!: () => void;
  const delivery = new Promise<void>((resolve) => {
    release = resolve;
  });
  let sending!: () => void;
  const entered = new Promise<void>((resolve) => {
    sending = resolve;
  });
  native.beforeSend = async () => {
    sending();
    await delivery;
  };
  const { controller } = testController({ home, checkout: process.cwd(), native });
  const start = controller.start({ runner: 'claude', model: 'opus' });
  await entered;
  assert.equal(controller.currentSession()?.status, 'starting');
  release();
  assert.equal((await start).session.status, 'running');
  await controller.stop();
});

test('Copilot effort persists without relabelling or replacing a live conversation', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'copilot-effort-config-'));
  const { controller, native } = testController({ home, checkout: process.cwd() });
  const fresh = await controller.status();
  assert.equal(fresh.session.runner, 'codex');
  assert.equal(fresh.session.model, 'gpt-6.1-sol');
  assert.equal(fresh.session.effort, 'low');
  await controller.configure({ runner: 'codex', model: 'gpt-5.6-sol', effort: 'medium' });
  const started = await controller.start();
  assert.equal(started.session.model, 'gpt-5.6-sol');
  assert.equal(started.session.effort, 'medium');
  await assert.rejects(controller.configure({ effort: 'low' }), /Stop the Co-Pilot runtime/);
  const reused = await controller.start({ runner: 'codex', model: 'gpt-6-astra', effort: 'low' });
  assert.equal(reused.reused, true);
  assert.equal(reused.session.model, 'gpt-5.6-sol');
  assert.equal(reused.session.effort, 'medium');
  assert.equal(native.launches, 1);
  await controller.dispose();
  const restored = testController({ home, checkout: process.cwd(), native }).controller;
  await restored.initialize();
  assert.equal((await restored.status()).session.effort, 'medium');
  await restored.stop();
  await restored.configure({ model: 'gpt-6-astra', effort: 'low' });
  assert.equal((await restored.start()).session.effort, 'low');
  await restored.stop();
});

test('stopped legacy configuration resolves next-start effort before confirmation', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'copilot-legacy-effort-'));
  const first = testController({ home, checkout: process.cwd() }).controller;
  await first.status();
  const store = new CopilotRuntimeStore(home);
  const legacy = (await store.load())!;
  delete legacy.session.effort;
  delete legacy.session.dangerousLaunch.effort;
  legacy.session.model = 'gpt-5.6-sol';
  await store.save(legacy);
  const restored = testController({ home, checkout: process.cwd() }).controller;
  const status = await restored.status();
  assert.equal(status.session.model, 'gpt-5.6-sol');
  assert.equal(status.session.effort, 'low');
  assert.equal(status.session.dangerousLaunch.effort, 'low');
});

test('explicit stop retires a failed pre-ensure reservation before a fresh start', async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), 'copilot-unmaterialized-stop-'));
  let fail = true;
  const { controller, native } = testController({
    home,
    checkout: process.cwd(),
    buildBootstrap: async () => {
      if (fail) throw new Error('Bootstrap source unavailable');
      return '# ready';
    },
  });
  t.after(async () => {
    await controller.dispose();
    await rm(home, { recursive: true, force: true });
  });
  await assert.rejects(controller.start(), /Bootstrap source unavailable/);
  const reservation = controller.currentSession()?.nativeSession?.sessionId;
  assert(reservation);
  assert.equal(native.launches, 0);
  assert.equal((await controller.stop()).session.status, 'stopped');
  fail = false;
  const next = await controller.start();
  assert.notEqual(next.session.nativeSession?.sessionId, reservation);
  assert.equal(native.launches, 1);
  await controller.stop();
});

test('stop fences a launch still building its bootstrap and sends no delayed command', async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), 'copilot-delayed-stop-'));
  let release!: () => void, entered!: () => void, stopEntered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const building = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const stoppingReached = new Promise<void>((resolve) => {
    stopEntered = resolve;
  });
  const { controller, native } = testController({
    home,
    checkout: process.cwd(),
    buildBootstrap: async () => {
      entered();
      await gate;
      return '# ready';
    },
  });
  t.after(async () => {
    release();
    await controller.dispose();
    await rm(home, { recursive: true, force: true });
  });
  const start = controller.start();
  await building;
  const stop = controller.stop({}, stopEntered);
  const settled = Promise.allSettled([start, stop]);
  void stop.then(stopEntered, stopEntered);
  await stoppingReached;
  release();
  const result = await settled;
  assert.equal(result[0].status, 'rejected');
  assert.equal(result[1].status, 'fulfilled');
  assert.equal(controller.currentSession()?.status, 'stopped');
  assert.equal(native.launches, 0);
  assert.equal(native.sends.size, 0);
});

test('the durable unacknowledged bootstrap intent remains starting while its launch is in flight', async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), 'copilot-intent-starting-'));
  const native = new FakeCopilotNative();
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const submitting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  native.beforeSend = async () => {
    const id = native.requests[0].params.sessionId;
    const commandId = 'copilot-bootstrap:' + id;
    native.sends.set(commandId, { commandId, state: 'unknown', submitted: true, accepted: false });
    native.publish();
    entered();
    await gate;
    native.sends.set(commandId, { commandId, state: 'accepted', submitted: true, accepted: true });
  };
  const { controller } = testController({ home, checkout: process.cwd(), native });
  const starting = controller.start();
  const done = Promise.allSettled([starting]);
  t.after(async () => {
    release();
    await done;
    await controller.dispose();
    await rm(home, { recursive: true, force: true });
  });
  await submitting;
  const deadline = Date.now() + 2000;
  while (controller.currentSession()?.lastDelivery.state !== 'deferred') {
    assert(Date.now() < deadline, 'The metadata observer did not commit the intent');
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(controller.currentSession()?.status, 'starting');
  release();
  assert.equal((await starting).session.status, 'running');
  await controller.stop();
});

test('a generic resume of the stopped session cannot create a second co-pilot', async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), 'copilot-generic-resume-'));
  const { controller, native } = testController({ home, checkout: process.cwd() });
  t.after(async () => {
    await controller.dispose();
    await rm(home, { recursive: true, force: true });
  });
  const started = await controller.start();
  const id = started.session.nativeSession!.sessionId;
  await controller.stop();
  const closed = native.sessions.get(id);
  assert(closed);
  native.sessions.set(id, {
    ...closed,
    state: 'idle',
    generation: 'generic-resume',
    processStopped: false,
  });
  native.publish();
  await assert.rejects(controller.start(), /resumed.*Stop|stop.*resumed/i);
  assert.equal([...native.sessions.values()].filter((info) => info.state !== 'closed').length, 1);
  await controller.stop();
  assert.equal(native.sessions.get(id)?.state, 'closed');
  const fresh = await controller.start();
  assert.notEqual(fresh.session.nativeSession?.sessionId, id);
  await controller.stop();
});

test('a restored stopped singleton with an unavailable host cannot reject gateway initialization', async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), 'copilot-stopped-unavailable-'));
  const first = testController({ home, checkout: process.cwd() });
  await first.controller.start();
  await first.controller.stop();
  await first.controller.dispose();
  class UnavailableNative extends FakeCopilotNative {
    override async inspect(): Promise<never> {
      throw Object.assign(new Error('Native host unavailable'), {
        code: 'NATIVE_SOURCE_UNAVAILABLE',
      });
    }
  }
  const native = new UnavailableNative();
  const { controller } = testController({ home, checkout: process.cwd(), native });
  t.after(async () => {
    await controller.dispose();
    await rm(home, { recursive: true, force: true });
  });
  await controller.initialize();
  assert.equal(controller.currentSession()?.status, 'failed');
  assert.match(controller.currentSession()?.terminalReason ?? '', /Native host unavailable/);
  await assert.rejects(() => controller.start(), /Native host unavailable/);
  assert.equal(native.launches, 0);
  assert.equal(native.sends.size, 0);
});
