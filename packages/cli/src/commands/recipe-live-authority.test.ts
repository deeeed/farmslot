import assert from 'node:assert/strict';
import { test } from 'node:test';

import { type EventFrame, Events } from '@farmslot/protocol';
import { contextPorts, type HarnessContext } from '@farmslot/recipe-cli/harness';

import type { GatewayConnection } from '../gateway-client.js';

import { withLiveRecipeAuthority } from './recipe-live-authority.js';

function allocation() {
  const run = { id: 'run', slotId: 'slot', project: 'example', status: 'human-gating' };
  const resource = {
    capabilityId: 'device',
    desiredDisposition: 'acquired',
    observedState: 'running',
    owner: { runId: 'run' },
    target: { simulator: 'device-id' },
  };
  const posture = {
    runId: 'run',
    slotId: 'slot',
    state: { posture: 'active', capabilities: [resource] },
  };
  let eventListener = (_event: EventFrame): void => {};
  let closeListener = (): void => {};
  let closed = false;
  const connection: GatewayConnection = {
    async call<T>(method: string): Promise<T> {
      assert.equal(closed, false);
      return structuredClone(method === 'run.get' ? { run } : posture) as T;
    },
    onEvent(handler) {
      eventListener = handler;
      return () => {
        eventListener = () => {};
      };
    },
    onClose(handler) {
      closeListener = handler;
      return () => {
        closeListener = () => {};
      };
    },
    close() {
      closed = true;
      closeListener();
    },
  };
  const context = {
    target: { value: '/checkout', source: 'flag', detail: '--target' },
    project: { name: 'example' },
    slot: { value: 'slot', source: 'slot', detail: 'slot-config', ports: {} },
  } as HarnessContext;
  return {
    run,
    resource,
    posture,
    connection,
    context,
    request: {
      context,
      headless: false,
      options: { disposable: true, run: 'run', device: 'device-id' },
      signal: new AbortController().signal,
    },
    connect: async () => connection,
    event: () => eventListener({ type: 'event', event: Events.RUNTIME_CAPABILITY_LIFECYCLE }),
    closed: () => closed,
  };
}

test('live proof uses an existing allocation and closes only its observation connection', async () => {
  const held = allocation();
  assert.equal(
    await withLiveRecipeAuthority(held.request, async () => 'checked', held.connect),
    'checked',
  );
  assert.equal(held.closed(), true);
  assert.equal(held.resource.observedState, 'running');
});

for (const scenario of ['foreign-run', 'unhealthy', 'wrong-device', 'no-resources'] as const) {
  test(`live proof refuses ${scenario} before invoking the provider`, async () => {
    const held = allocation();
    if (scenario === 'foreign-run') held.run.slotId = 'other-slot';
    if (scenario === 'unhealthy') held.resource.observedState = 'unhealthy';
    if (scenario === 'wrong-device') held.request.options.device = 'other-device';
    if (scenario === 'no-resources') held.posture.state.capabilities = [];
    await assert.rejects(
      withLiveRecipeAuthority(
        held.request,
        async () => assert.fail('unauthorized invocation'),
        held.connect,
      ),
    );
    assert.equal(held.closed(), true);
  });
}

for (const failure of ['lease-loss', 'disconnect'] as const) {
  test(
    `live proof cancels on ${failure} and cannot return a passing result`,
    { timeout: 1000 },
    async () => {
      const held = allocation();
      let aborted = false;
      await assert.rejects(
        withLiveRecipeAuthority(
          held.request,
          async (signal) => {
            const stopped = new Promise<void>((resolve) =>
              signal.addEventListener(
                'abort',
                () => {
                  aborted = true;
                  resolve();
                },
                { once: true },
              ),
            );
            if (failure === 'lease-loss') {
              held.resource.observedState = 'stopped';
              held.event();
            } else held.connection.close();
            await stopped;
            return 'must not pass';
          },
          held.connect,
        ),
      );
      assert.equal(aborted, true);
      assert.equal(held.closed(), true);
    },
  );
}

test('unallocated UI and missing disposable consent refuse before connecting or invoking', async () => {
  const held = allocation();
  const connect = async (): Promise<GatewayConnection> => assert.fail('unexpected connection');
  const invoke = async () => assert.fail('unexpected invocation');
  await assert.rejects(
    withLiveRecipeAuthority({ ...held.request, options: {} }, invoke, connect),
    /--disposable/u,
  );
  await assert.rejects(
    withLiveRecipeAuthority(
      { ...held.request, context: { ...held.context, slot: undefined } },
      invoke,
      connect,
    ),
    /headless/u,
  );
});

for (const name of [
  'RECIPE_CDP_PORT',
  'CDP_PORT',
  'TERMINAL_APP_PORT',
  'RECIPE_WATCHER_PORT',
  'WATCHER_PORT',
  'METRO_PORT',
]) {
  test(`live proof checks inherited ${name} against allocated ports`, async () => {
    const held = allocation();
    assert.ok(held.context.slot?.value);
    held.context.slot.ports = { cdpPort: 9323, watcherPort: 8081 };
    const grammar = { '--cdp-port': true, '--watcher-port': true };
    held.context.ports = contextPorts(held.context, [], grammar, { [name]: '9222' }).ports;
    await assert.rejects(
      withLiveRecipeAuthority(
        held.request,
        async () => assert.fail('provider must not run on another slot transport'),
        async () => assert.fail('mismatched transport must refuse before connecting'),
      ),
      /port differs from its allocated slot/u,
    );
    held.context.ports = contextPorts(held.context, [], grammar, {
      [name]: name.includes('CDP') ? '9323' : '8081',
    }).ports;
    assert.equal(
      await withLiveRecipeAuthority(held.request, async () => 'checked', held.connect),
      'checked',
    );
  });
}
