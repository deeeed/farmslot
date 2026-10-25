import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { CopilotRuntimeSession } from '@farmslot/protocol';

import { resourceRevisions } from '../resources/revisions.js';

await import('../runtime/mock-pty.test-support.js');
const { CopilotRuntimeController } = await import('./controller.js');
const { CopilotRuntimeStore } = await import('./session-store.js');
const { FakeCopilotTmux, testCheckout, testController, testWorkload } =
  await import('./test-helpers.js');

const runtimeKey = { family: 'copilot', ownerId: 'gateway-copilot' } as const;

test('owning runtime initialization, start, reconnect and stop publish already readable persistence', async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), 'copilot-lifecycle-publication-'));
  const previousAutostart = process.env.FARMSLOT_COPILOT_DANGEROUS_AUTOSTART;
  delete process.env.FARMSLOT_COPILOT_DANGEROUS_AUTOSTART;
  let nowMs = Date.parse('2026-10-26T00:00:00.000Z');
  const now = () => new Date(nowMs);
  const { controller, tmux } = testController({ home, checkout: home, now });
  const controllers = [controller];
  let activeController = controller;
  const store = new CopilotRuntimeStore(home);
  t.after(async () => {
    try {
      for (const current of controllers) {
        activeController = current;
        if (
          ['starting', 'running', 'reconnecting'].includes(current.currentSession()?.status ?? '')
        )
          await current.stop({ reason: 'private-fixture-cleanup' });
      }
    } finally {
      if (previousAutostart === undefined) delete process.env.FARMSLOT_COPILOT_DANGEROUS_AUTOSTART;
      else process.env.FARMSLOT_COPILOT_DANGEROUS_AUTOSTART = previousAutostart;
      await rm(home, { recursive: true, force: true });
    }
  });
  const published: CopilotRuntimeSession[] = [];
  const advance = resourceRevisions.advance.bind(resourceRevisions);
  t.mock.method(
    resourceRevisions,
    'advance',
    (...args: Parameters<typeof resourceRevisions.advance>) => {
      assert.deepEqual(args[0], runtimeKey, 'Runtime keys contain no checkout or private session');
      const durable = JSON.parse(readFileSync(store.sessionPath, 'utf8'));
      assert.deepEqual(
        durable.session,
        JSON.parse(JSON.stringify(activeController.currentSession())),
        'The runtime projection is durable and readable before each publication',
      );
      published.push(durable.session);
      advance(...args);
    },
  );
  let before = resourceRevisions.revision(runtimeKey);
  await controller.initialize();
  assert.equal(await store.load(), null);
  assert.equal(
    resourceRevisions.revision(runtimeKey),
    before,
    'Empty initialization is not a write',
  );
  await controller.status();
  assert(resourceRevisions.revision(runtimeKey) > before);
  assert.equal(published.at(-1)?.status, 'stopped');

  nowMs += 1;
  before = resourceRevisions.revision(runtimeKey);
  const startIndex = published.length;
  const started = await controller.start({ runner: 'cursor', model: 'test-model' });
  assert.equal(started.reused, false);
  assert(resourceRevisions.revision(runtimeKey) > before);
  assert(published.slice(startIndex).some((session) => session.status === 'starting'));
  assert.equal(published.at(-1)?.status, 'running');
  assert.equal(tmux.launchCount, 1);

  nowMs += 1;
  before = resourceRevisions.revision(runtimeKey);
  const reconnected = await controller.start({ mode: 'reconnect' });
  assert.equal(reconnected.reused, true);
  assert(resourceRevisions.revision(runtimeKey) > before);
  assert.equal(published.at(-1)?.reconnectedAt, now().toISOString());
  assert.equal(tmux.launchCount, 1, 'Explicit reconnect reuses the fake runtime');

  nowMs += 1;
  const restored = testController({ home, checkout: home, tmux, now }).controller;
  controllers.push(restored);
  activeController = restored;
  before = resourceRevisions.revision(runtimeKey);
  await restored.initialize();
  assert(resourceRevisions.revision(runtimeKey) > before);
  assert.equal(restored.currentSession()?.status, 'running');
  assert.equal(published.at(-1)?.reconnectedAt, now().toISOString());
  assert.equal(published.at(-1)?.runtimeId, started.session.runtimeId);
  assert.equal(tmux.launchCount, 1, 'Persisted initialization must not launch another runtime');

  nowMs += 1;
  before = resourceRevisions.revision(runtimeKey);
  const stopIndex = published.length;
  await restored.stop({ reason: 'operator-requested' });
  assert(resourceRevisions.revision(runtimeKey) > before);
  assert(published.slice(stopIndex).some((session) => session.status === 'stopping'));
  assert.equal(published.at(-1)?.status, 'stopped');
  assert.equal(published.at(-1)?.terminalReason, 'operator-requested');
  assert.equal((await store.load())?.session.status, 'stopped');
  assert.equal(tmux.killCount, 1);
});

test('readable runtime configuration publishes while read timestamps do not cause a refetch loop', async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), 'copilot-resource-changes-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  let nowMs = Date.parse('2026-10-24T00:00:00Z');
  const { controller } = testController({
    home,
    checkout: process.cwd(),
    now: () => new Date(nowMs),
  });
  await controller.status();
  const initial = resourceRevisions.revision(runtimeKey);
  nowMs += 1;
  await controller.status();
  assert.equal(
    resourceRevisions.revision(runtimeKey),
    initial,
    'A read-only timestamp write must not invalidate its own observed query',
  );
  await controller.configure({ autostart: true });
  assert(resourceRevisions.revision(runtimeKey) > initial);
  const readable = await new CopilotRuntimeStore(home).load();
  assert.equal(
    readable?.session.autostart,
    true,
    'A published configuration must already be durable and readable',
  );
  const configured = resourceRevisions.revision(runtimeKey);
  nowMs += 1;
  await controller.status();
  assert.equal(resourceRevisions.revision(runtimeKey), configured);
});

test('failed owning persistence publishes no runtime revision', async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), 'copilot-resource-failure-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const store = new CopilotRuntimeStore(home);
  const controller = new CopilotRuntimeController({
    store,
    observeCheckout: async () => async () => {},
    tmux: new FakeCopilotTmux(),
    checkout: process.cwd(),
    inspectCheckout: async () => testCheckout(process.cwd()),
    workload: testWorkload,
  });
  await controller.status();
  const before = resourceRevisions.revision(runtimeKey);
  store.save = async () => {
    throw new Error('injected durable write failure');
  };
  await assert.rejects(controller.configure({ autostart: true }), /injected durable write failure/);
  assert.equal(resourceRevisions.revision(runtimeKey), before);
});

test('status arms its exact checkout source before inspection and refuses a changed source', async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), 'copilot-source-boundary-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const order: string[] = [];
  let changed = false;
  const controller = new CopilotRuntimeController({
    store: new CopilotRuntimeStore(home),
    tmux: new FakeCopilotTmux(),
    checkout: '/server-owned/copilot-checkout',
    observeCheckout: async (checkout) => {
      assert.equal(checkout, '/server-owned/copilot-checkout');
      order.push('armed');
      return async () => {
        order.push('confirmed');
        if (changed) throw new Error('source changed during read');
      };
    },
    inspectCheckout: async (checkout) => {
      order.push('inspected');
      return testCheckout(checkout);
    },
    workload: testWorkload,
  });
  await controller.status();
  assert.deepEqual(order, ['armed', 'inspected', 'confirmed']);
  changed = true;
  await assert.rejects(controller.status(), /source changed during read/);
});
