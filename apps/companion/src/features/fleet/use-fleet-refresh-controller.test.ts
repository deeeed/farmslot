import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { Events, type FleetStatusResult, Methods, type SlotStatus } from '@farmslot/protocol';
import type { ResourceQuery, ResourceQueryState } from '@farmslot/protocol/client-cache';
import { FleetRefreshViewModel } from '@farmslot/review-dispatch';

import type { GatewayClient } from '../../lib/gateway-client';
import { nativeFleetQuery } from '../../lib/gateway-run-sync';

const fleet = (stale = false, slots: SlotStatus[] = []): FleetStatusResult => ({
  fleet: {
    checkedAt: '2026-10-28T00:00:00.000Z',
    slots,
    summary: {
      total: slots.length,
      ready: slots.length,
      busy: 0,
      held: 0,
      manual: 0,
      disabled: 0,
      blocked: 0,
      warmCount: 0,
    },
    stale,
  },
});

let owner = 'owner-a';
let fleetState: ResourceQueryState<FleetStatusResult> = { status: 'loading' };
let retries = 0;
let pendingRead: ((state: ResourceQueryState<FleetStatusResult>) => void) | undefined;
// Reads the current in-flight cache read without the narrowing of an earlier assignment.
const readInFlight = () => pendingRead;
const cache = {
  read(query: ResourceQuery<unknown>) {
    assert.equal(query.id, nativeFleetQuery.id);
    return fleetState;
  },
  retry(query: ResourceQuery<unknown>) {
    assert.equal(query.id, nativeFleetQuery.id);
    retries++;
    return new Promise<ResourceQueryState<FleetStatusResult>>((resolve) => {
      pendingRead = resolve;
    });
  },
};
mock.module('../../lib/resource-cache', {
  namedExports: { getResourceCache: () => cache, getResourceWorkspaceKey: () => owner },
});
// Mirrors the store's rule: a ready, non-stale fleet observation on the current connection.
mock.module('../../lib/run-collections', {
  namedExports: {
    assertNativeFleetReady() {
      const observed = cache.read(nativeFleetQuery);
      if (observed.status !== 'ready' || !observed.data || observed.data.fleet.stale)
        throw new Error('Wait for a current fleet read before acting.');
      return observed.data.fleet;
    },
  },
});

const sent: string[] = [];
let held: ((value: unknown) => void) | undefined;
const client = {
  connectionGeneration: 1,
  connectionState: 'connected',
  workspaceAccess: 'farm',
  authenticatedPrincipal: { id: 'operator' } as { id: string } | null,
  request(method: string) {
    sent.push(method);
    return new Promise((resolve) => {
      held = resolve;
    });
  },
};
const authority = {
  client: client as unknown as GatewayClient,
  status: 'connected',
  activeProfileId: 'profile-a',
  authorityEpoch: 0,
};
mock.module('../../store/connection', {
  namedExports: {
    useConnectionStore: Object.assign(
      (select: (state: typeof authority) => unknown) => select(authority),
      { getState: () => authority },
    ),
  },
});

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

async function fleetRequest() {
  const { fleetRefreshRequest } = await import('./use-fleet-refresh-controller');
  return fleetRefreshRequest(client as unknown as GatewayClient);
}

function reset(state: ResourceQueryState<FleetStatusResult>) {
  owner = 'owner-a';
  fleetState = state;
  retries = 0;
  pendingRead = undefined;
  sent.length = 0;
  held = undefined;
  client.connectionGeneration = 1;
  client.authenticatedPrincipal = { id: 'operator' };
}

async function answered<T>(promise: Promise<T>, value: unknown = { ok: true }): Promise<T> {
  await turn();
  assert(held, 'the command was not sent');
  held(value);
  return promise;
}

test('an inspection rereads the shared fleet observation and never sends fleet.status', async () => {
  const request = await fleetRequest();
  reset({ status: 'stale', data: fleet(), observedAt: 1 });
  const inspecting = request<FleetStatusResult>(Methods.FLEET_STATUS);
  assert.equal(retries, 1);
  assert(pendingRead);
  const current = fleet();
  pendingRead({ status: 'ready', data: current, observedAt: Date.now() });
  assert.equal(await inspecting, current);
  assert.deepEqual(sent, []);
});

test('an inspection fails visibly when its read errors or the owner or connection changes', async () => {
  const request = await fleetRequest();
  reset({ status: 'ready', data: fleet(), observedAt: 1 });
  const failed = request(Methods.FLEET_STATUS);
  pendingRead!({
    status: 'stale',
    data: fleet(),
    observedAt: 1,
    error: { code: 'READ_FAILED', message: 'Fleet source unavailable' },
  });
  await assert.rejects(failed, /Fleet source unavailable/);

  const ownerChanged = request(Methods.FLEET_STATUS);
  owner = 'owner-b';
  pendingRead!({ status: 'ready', data: fleet(), observedAt: Date.now() });
  await assert.rejects(ownerChanged, /inspect again/);

  owner = 'owner-a';
  const reconnected = request(Methods.FLEET_STATUS);
  client.connectionGeneration = 2;
  pendingRead!({ status: 'ready', data: fleet(), observedAt: Date.now() });
  await assert.rejects(reconnected, /inspect again/);
  assert.deepEqual(sent, []);
});

test('release and bulk release are refused before a current fleet read and sent after one', async () => {
  const request = await fleetRequest();
  for (const state of [
    { status: 'stale', data: fleet(), observedAt: 1 },
    { status: 'ready', data: fleet(true), observedAt: Date.now() },
    { status: 'loading' },
  ] satisfies ResourceQueryState<FleetStatusResult>[]) {
    reset(state);
    await assert.rejects(request(Methods.SLOT_REFRESH, { slotId: 's1' }), /current fleet read/);
    await assert.rejects(
      request(Methods.FLEET_REFRESH_SLOTS, { slotIds: ['s1'] }),
      /current fleet read/,
    );
    assert.deepEqual(sent, [], `${state.status} fleet sent a release`);
  }

  reset({ status: 'ready', data: fleet(), observedAt: Date.now() });
  await answered(request(Methods.SLOT_REFRESH, { slotId: 's1' }));
  await answered(request(Methods.FLEET_REFRESH_SLOTS, { slotIds: ['s1'] }));
  assert.deepEqual(sent, [Methods.SLOT_REFRESH, Methods.FLEET_REFRESH_SLOTS]);
});

test('cancel is sent while the fleet read is stale', async () => {
  const request = await fleetRequest();
  reset({ status: 'stale', data: fleet(), observedAt: 1 });
  assert.deepEqual(
    await answered(request(Methods.FLEET_REFRESH_SLOTS_CANCEL, { requestId: 'r1' }), {
      cancelled: true,
    }),
    { cancelled: true },
  );
  assert.deepEqual(sent, [Methods.FLEET_REFRESH_SLOTS_CANCEL]);
});

test('an unknown method is refused', async () => {
  const request = await fleetRequest();
  reset({ status: 'ready', data: fleet(), observedAt: Date.now() });
  await assert.rejects(request('slot.delete', { slotId: 's1' }), /does not send slot\.delete/);
  await assert.rejects(request(Methods.RUN_LIST), /does not send run\.list/);
  assert.deepEqual(sent, []);
});

test('a principal switch during a command rejects its acknowledgement', async () => {
  const request = await fleetRequest();
  reset({ status: 'ready', data: fleet(), observedAt: Date.now() });
  const releasing = request(Methods.SLOT_REFRESH, { slotId: 's1' });
  await turn();
  assert.deepEqual(sent, [Methods.SLOT_REFRESH]);
  client.authenticatedPrincipal = { id: 'another-operator' };
  held!({ ok: true });
  await assert.rejects(releasing, /changed before acknowledgement/);
});

// Pins: fleetRefreshRequest's FLEET_STATUS branch (cache.retry of nativeFleetQuery), as reached
// by the view model's row refresh on fleet.updated during review.
test('a review refresh on fleet.updated rereads through the cache and never sends fleet.status', async () => {
  const request = await fleetRequest();
  reset({ status: 'ready', data: fleet(), observedAt: 1 });
  const listeners = new Map<string, () => void>();
  const model = new FleetRefreshViewModel(
    {
      contextKey: () => 'owner-a',
      request,
      subscribe: (event, callback) => {
        listeners.set(event, () => callback(undefined));
        return () => listeners.delete(event);
      },
    },
    () => 'fleet-refresh-test',
  );
  const slot = {
    slot: 's1',
    enabled: true,
    lifecycle: 'ready',
    health: { ssh: 'OK' },
    branch: 'feat/x',
  } as unknown as SlotStatus;
  const withSlot = fleet(false, [slot]);
  try {
    const loading = model.load(['s1']);
    assert.equal(retries, 1);
    pendingRead!({ status: 'ready', data: withSlot, observedAt: Date.now() });
    await loading;
    assert.equal(model.phase, 'review');
    pendingRead = undefined;

    listeners.get(Events.FLEET_UPDATED)!();
    await turn();
    assert.equal(retries, 2, 'the observed update rereads the shared fleet query');
    const refreshRead = readInFlight();
    assert(refreshRead, 'the refresh opened its own cache read');
    refreshRead({ status: 'ready', data: withSlot, observedAt: Date.now() });
    await turn();
    assert.deepEqual(sent, [], 'no direct fleet.status request');
  } finally {
    model.dispose();
  }
});
