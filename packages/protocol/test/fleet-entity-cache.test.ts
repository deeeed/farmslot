/**
 * Cache-level tests for fleet entity sync (ADR-071 Amendment 3).
 *
 * Four scenarios:
 * 1. data-only: collection held + complete, no staleness → assemble with zero extra RPCs
 * 2. membership: a slots membership change triggers exactly one versions read
 * 3. cold start: stored rows hydrate the collection, zero ids-read RPCs
 * 4. old gateway: no entitySync capability → full RPC used
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createGatewayResourceCache } from '../src/client-cache/cache.js';
import { ResourceCacheConformanceTransport } from '../src/client-cache/conformance.js';
import { resourceQuery } from '../src/client-cache/registry.js';
import { createMemoryResourceStore } from '../src/client-cache/store.js';
import type { ResourceCacheConnection } from '../src/client-cache/types.js';
import type { SlotEntity, SlotStatus } from '../src/contracts/slots.js';
import type { FleetEntityPage, FleetStatusResult, FleetVersionsResult } from '../src/rpc/fleet.js';
import { Methods } from '../src/rpc/registry.js';

const scope = {
  gatewayUrl: 'ws://fleet-entity-test.invalid/',
  principalId: 'test-principal',
  principalGeneration: 0,
};

const fleetQuery = resourceQuery<FleetStatusResult>(Methods.FLEET_STATUS);

function makeSlotEntity(slotId: string, branch = 'main'): SlotEntity {
  return {
    slot: slotId,
    machine: 'testmachine',
    platform: 'macos',
    project: 'example',
    health: { ssh: 'OK', device: '-', devserver: 'OK', cdp: '-', fixtures: '-' },
    branch,
    agent: 'idle',
    enabled: true,
    dispatchable: true,
    lifecycle: 'ready',
    phase: null,
    warm: false,
    taskId: null,
    taskFile: null,
    dispatchedAt: null,
    completedAt: null,
    runner: null,
    model: null,
    deviceName: null,
    taskPhase: null,
    taskStepProgress: null,
  };
}

function makeVersionsResult(entities: SlotEntity[]): FleetVersionsResult {
  return {
    versions: entities.map((e) => ({ id: e.slot, version: `v-${e.slot}` })),
    summary: {
      total: entities.length,
      ready: entities.length,
      busy: 0,
      disabled: 0,
      offline: 0,
      warmReady: 0,
    },
    checkedAt: new Date().toISOString(),
  };
}

function makePageResult(entities: SlotEntity[]): FleetEntityPage {
  return {
    entities,
    versions: entities.map((e) => ({ id: e.slot, version: `v-${e.slot}` })),
  };
}

/** Connect transport with entitySync capability. Fleet.status requires observedReads: 1. */
function entitySyncConnection(base: ResourceCacheConformanceTransport): ResourceCacheConnection {
  return {
    ...base.connection,
    id: 1,
    connected: true,
    capabilities: {
      ...base.connection.capabilities,
      resourceChanges: {
        version: 1 as const,
        epoch: 'conformance-epoch',
        versionLists: false,
        observedReads: 1 as const,
        entitySync: true,
      },
    },
  };
}

/** Connect transport without entitySync but with observedReads for plain fleet.status. */
function legacyGatewayConnection(base: ResourceCacheConformanceTransport): ResourceCacheConnection {
  return {
    ...base.connection,
    id: 1,
    connected: true,
    capabilities: {
      ...base.connection.capabilities,
      resourceChanges: {
        version: 1 as const,
        epoch: 'conformance-epoch',
        versionLists: false,
        observedReads: 1 as const,
      },
    },
  };
}

/** Wait until a cache observer emits a state with data or error (non-loading). */
function waitForData<T>(
  cache: ReturnType<typeof createGatewayResourceCache>,
  query: ReturnType<typeof resourceQuery<T>>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('waitForData timeout')), 3000);
    const stop = cache.observe(query as ReturnType<typeof resourceQuery>, (state) => {
      if (state.status === 'ready') {
        if (state.data !== undefined) {
          clearTimeout(timer);
          stop();
          resolve(state.data as T);
        }
      } else if (state.status === 'error') {
        clearTimeout(timer);
        stop();
        reject(state.error ?? new Error('cache error'));
      }
    });
  });
}

test(
  'fleet entity cache: data-only path uses zero extra RPCs after collection is fully held',
  { timeout: 5000 },
  async () => {
    const slot = makeSlotEntity('macwork-01');
    const transport = new ResourceCacheConformanceTransport(scope);
    transport.setConnection(entitySyncConnection(transport));
    const cache = createGatewayResourceCache({ transport });

    // First read: versions read + page read (2 RPCs total)
    const reading = waitForData<FleetStatusResult>(cache, fleetQuery);

    // Respond to versions read
    const versionsRead = await transport.nextRead();
    versionsRead.resolve(makeVersionsResult([slot]));

    // Respond to page read
    const pageRead = await transport.nextRead();
    pageRead.resolve(makePageResult([slot]));

    const result = await reading;
    assert.ok(result.fleet, 'fleet data present');
    assert.equal(result.fleet.slots.length, 1);
    assert.equal(result.fleet.slots[0].slot, 'macwork-01');

    const countAfterFirstRead = transport.requestCount;

    // Push a slot entity update via resourceChanges (no RPC — entity is pushed inline)
    const updatedSlot = makeSlotEntity('macwork-01', 'feature-branch');
    transport.publish({
      version: 1,
      epoch: 'conformance-epoch',
      changes: [
        {
          key: { family: 'slot', slotId: 'macwork-01' },
          revision: 2,
          kind: 'updated',
          changedEntity: { family: 'slot', entity: updatedSlot, version: 'v2' },
        },
      ],
    });

    // A second read should use zero extra RPCs (entity already applied inline)
    const reading2 = waitForData<FleetStatusResult>(cache, fleetQuery);
    const result2 = await reading2;
    assert.equal(result2.fleet.slots[0].branch, 'feature-branch', 'inline entity applied');
    assert.equal(
      transport.requestCount,
      countAfterFirstRead,
      'no extra RPCs after inline entity push',
    );

    cache.dispose();
  },
);

test(
  'fleet entity cache: membership change triggers one versions read',
  { timeout: 5000 },
  async () => {
    const slot = makeSlotEntity('macwork-01');
    const slot2 = makeSlotEntity('macwork-02');
    const transport = new ResourceCacheConformanceTransport(scope);
    transport.setConnection(entitySyncConnection(transport));
    const cache = createGatewayResourceCache({ transport });

    // First read: versions + page
    const reading = waitForData<FleetStatusResult>(cache, fleetQuery);
    const versionsRead = await transport.nextRead();
    versionsRead.resolve(makeVersionsResult([slot]));
    const pageRead = await transport.nextRead();
    pageRead.resolve(makePageResult([slot]));
    await reading;

    const countAfterFirst = transport.requestCount;

    // Push membership change (new slot added)
    transport.publish({
      version: 1,
      epoch: 'conformance-epoch',
      changes: [
        {
          key: { family: 'slots', scope: 'farm' },
          revision: 2,
          kind: 'updated',
          membershipRevision: 2,
        },
      ],
    });

    // Next fleet.status read must trigger exactly one versions read (new membership)
    const reading2 = waitForData<FleetStatusResult>(cache, fleetQuery);
    const versionsRead2 = await transport.nextRead();
    // respond with the new membership (2 slots)
    versionsRead2.resolve(makeVersionsResult([slot, slot2]));
    // page read for the new slot
    const pageRead2 = await transport.nextRead();
    pageRead2.resolve(makePageResult([slot2]));
    const result2 = await reading2;

    assert.equal(result2.fleet.slots.length, 2);
    // Exactly one versions read triggered (the membership update)
    assert.equal(
      transport.requestCount - countAfterFirst,
      2,
      'one versions read + one page read for new slot',
    );

    cache.dispose();
  },
);

test(
  'fleet entity cache: cold start from stored rows uses zero ids-read RPCs',
  { timeout: 5000 },
  async () => {
    const slot = makeSlotEntity('macwork-cold');
    const memory = createMemoryResourceStore();
    await memory.setMetadata({
      scope,
      authority: { roles: [], workspaceAccess: 'farm' },
    });
    // createMemoryResourceStore returns persistent:false; warmStoredQueries skips that guard.
    // Spread to override so the cache loads the pre-seeded fleet rows on startup.
    // All methods are closures — spread is safe. `deleted` never changes in this test.
    const store: ReturnType<typeof createMemoryResourceStore> = { ...memory, persistent: true };

    // Pre-seed the store with fleet rows (mimics a previous session's persist)
    // Same stable key used by the cache internally; must stay in sync with cache.ts
    const fleetCollectionId = 'fleet.status:{"versions":true}';
    if (store.mergeRows) {
      const enc = new TextEncoder();
      const entityJson = JSON.stringify(slot);
      await store.mergeRows(fleetCollectionId, {
        entry: {
          id: fleetCollectionId,
          data: {
            summary: { total: 1, ready: 1, busy: 0, disabled: 0, offline: 0, warmReady: 0 },
            checkedAt: new Date().toISOString(),
          },
          observedAt: Date.now(),
          bytes: 50,
        },
        upserts: [
          {
            id: slot.slot,
            version: `v-${slot.slot}`,
            projection: { slot: slot.slot },
            body: slot,
            bytes: enc.encode(entityJson).byteLength,
          },
        ],
        deletes: [],
      });
    }

    const transport = new ResourceCacheConformanceTransport(scope);
    transport.connection = {
      ...transport.connection,
      authority: { roles: [], workspaceAccess: 'farm' },
    };
    transport.setConnection(entitySyncConnection(transport));
    const cache = createGatewayResourceCache({ transport, store });

    // Allow warm startup queries to run (store hydration is async)
    await new Promise((r) => setTimeout(r, 50));

    const countBeforeRead = transport.requestCount;
    const reading = waitForData<FleetStatusResult>(cache, fleetQuery);

    // If the cache serves from stored rows, no ids-read RPC should fire.
    // A versions read may fire to confirm freshness, but no page-read RPCs.
    // Respond to any versions read that arrives (confirms no membership change)
    const versionsReadOrTimeout = Promise.race([
      transport.nextRead().then((r) => {
        r.resolve(makeVersionsResult([slot]));
        return 'versions';
      }),
      new Promise<string>((r) => setTimeout(() => r('timeout'), 300)),
    ]);
    const outcome = await versionsReadOrTimeout;
    if (outcome === 'versions') {
      // No page read needed: entity already in store at same version
      // But if one fires, respond
      const pageOrTimeout = Promise.race([
        transport.nextRead().then((r) => {
          r.resolve(makePageResult([slot]));
          return 'page';
        }),
        new Promise<string>((r) => setTimeout(() => r('timeout'), 300)),
      ]);
      await pageOrTimeout;
    }

    const result = await reading;
    assert.ok(result.fleet.slots.length >= 1, 'fleet slot served');
    // Zero ids-read RPCs: at most one versions read is acceptable
    assert.ok(
      transport.requestCount - countBeforeRead <= 1,
      'at most one versions read RPC from stored cold start',
    );

    cache.dispose();
  },
);

test(
  'fleet entity cache: no entitySync capability falls through to full RPC',
  { timeout: 5000 },
  async () => {
    const slot = makeSlotEntity('macwork-noes');
    const transport = new ResourceCacheConformanceTransport(scope);
    // Connect WITHOUT entitySync (but with observedReads to allow fleet.status)
    transport.setConnection(legacyGatewayConnection(transport));
    const cache = createGatewayResourceCache({ transport });

    const reading = waitForData<FleetStatusResult>(cache, fleetQuery);
    // Should get one plain fleet.status RPC (not entitySync versions/ids)
    const rpc = await transport.nextRead();
    // SlotEntity is Omit<SlotStatus, 'hostLoad'>; hostLoad is optional so the fixture is a valid SlotStatus.
    const slotAsStatus: SlotStatus = slot;
    rpc.resolve({
      fleet: {
        checkedAt: new Date().toISOString(),
        slots: [slotAsStatus],
        summary: { total: 1, ready: 1, busy: 0, disabled: 0, offline: 0, warmReady: 0 },
      },
    });

    const result = await reading;
    assert.equal(result.fleet.slots.length, 1);
    assert.equal(transport.requestCount, 1, 'exactly one full RPC (no entity sync)');

    cache.dispose();
  },
);
