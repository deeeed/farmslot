import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resourceRevisions } from '../resources/revisions.js';

await import('../runtime/mock-pty.test-support.js');
const { CopilotRuntimeController } = await import('./controller.js');
const { CopilotRuntimeStore } = await import('./session-store.js');
const { FakeCopilotTmux, testCheckout, testController, testWorkload } =
  await import('./test-helpers.js');

const runtimeKey = { family: 'copilot', ownerId: 'gateway-copilot' } as const;

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
