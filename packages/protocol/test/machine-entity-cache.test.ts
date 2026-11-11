/**
 * Cache-level tests for machine health entity sync (ADR-071 Amendment 3).
 *
 * Tests:
 * 1. machine-only push: fleet.machines and slot hostLoad update with zero RPCs
 * 2. old gateway (no entitySync): machines arrive via full read; machine push ignored
 *
 * Revert proof for test 1: removing the `'node'` family handler in cache.ts causes the
 * observer to never re-emit after the machine push; the waitFor call times out and the
 * test fails with "machine push must update hostLoad — timed out".
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createGatewayResourceCache } from '../src/client-cache/cache.js';
import { ResourceCacheConformanceTransport } from '../src/client-cache/conformance.js';
import { resourceQuery } from '../src/client-cache/registry.js';
import type { ResourceCacheConnection } from '../src/client-cache/types.js';
import type { MachineHealth, SlotEntity } from '../src/contracts/slots.js';
import type { FleetEntityPage, FleetStatusResult, FleetVersionsResult } from '../src/rpc/fleet.js';
import { Methods } from '../src/rpc/registry.js';

const EPOCH = 'machine-entity-epoch';

const scope = {
  gatewayUrl: 'ws://machine-entity-test.invalid/',
  principalId: 'test-principal',
  principalGeneration: 0,
};

const fleetQuery = resourceQuery<FleetStatusResult>(Methods.FLEET_STATUS);

function makeMachineHealth(headroom: MachineHealth['headroom']): MachineHealth {
  const red = headroom === 'red';
  return {
    machine: 'testmachine',
    online: true,
    headroom,
    system: {
      cpuPercent: red ? 95 : 10,
      memoryPercent: red ? 92 : 20,
      diskPercent: red ? 10 : 5,
      memoryUsedGb: red ? 29 : 6,
      memoryTotalGb: 32,
      loadAvg1: red ? 9.5 : 1.0,
      loadAvg5: red ? 8.0 : 0.8,
      collectedAt: new Date().toISOString(),
    },
    capacity: { maxSlots: 4, activeSlots: 1, cpuCores: 8 },
  };
}

function makeSlot(): SlotEntity {
  return {
    slot: 's1',
    machine: 'testmachine',
    platform: 'macos',
    project: 'example',
    health: { ssh: 'OK', device: '-', devserver: 'OK', cdp: '-', fixtures: '-' },
    branch: 'main',
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

function entitySyncConnection(base: ResourceCacheConformanceTransport): ResourceCacheConnection {
  return {
    ...base.connection,
    id: 1,
    connected: true,
    capabilities: {
      ...base.connection.capabilities,
      resourceChanges: {
        version: 1 as const,
        epoch: EPOCH,
        versionLists: false,
        observedReads: 1 as const,
        entitySync: true,
      },
    },
  };
}

function legacyGatewayConnection(base: ResourceCacheConformanceTransport): ResourceCacheConnection {
  return {
    ...base.connection,
    id: 1,
    connected: true,
    capabilities: {
      ...base.connection.capabilities,
      resourceChanges: {
        version: 1 as const,
        // Must match the conformance transport's stamp epoch so stampCovers returns true
        // and the full-read status becomes 'ready' (not 'stale').
        epoch: 'conformance-epoch',
        versionLists: false,
        observedReads: 1 as const,
      },
    },
  };
}

/** Wait until fleet.status observer emits ready data satisfying predicate. */
function waitFor(
  cache: ReturnType<typeof createGatewayResourceCache>,
  predicate: (data: FleetStatusResult) => boolean,
  label: string,
): Promise<FleetStatusResult> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} — timed out`)), 3000);
    const stop = cache.observe(fleetQuery as ReturnType<typeof resourceQuery>, (state) => {
      if (state.status === 'ready' && state.data !== undefined) {
        const data = state.data as FleetStatusResult;
        if (predicate(data)) {
          clearTimeout(timer);
          stop();
          resolve(data);
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
  'machine entity cache: machine-only push updates fleet.machines and slot hostLoad with zero RPCs',
  { timeout: 8000 },
  async () => {
    const slot = makeSlot();
    const machineGreen = makeMachineHealth('green');
    const machineRed = makeMachineHealth('red');

    const versionsResult: FleetVersionsResult = {
      versions: [{ id: slot.slot, version: 'v-s1' }],
      summary: {
        total: 1,
        ready: 1,
        busy: 0,
        held: 0,
        manual: 0,
        disabled: 0,
        blocked: 0,
        warmCount: 0,
      },
      checkedAt: new Date().toISOString(),
      machines: [machineGreen],
    };
    const pageResult: FleetEntityPage = {
      entities: [slot],
      versions: [{ id: slot.slot, version: 'v-s1' }],
    };

    const transport = new ResourceCacheConformanceTransport(scope);
    transport.setConnection(entitySyncConnection(transport));
    const cache = createGatewayResourceCache({ transport });

    // Phase 1: initial load — drive versions + page reads.
    const reading = waitFor(cache, (d) => d.fleet.slots.length > 0, 'initial load');

    const versionsRead = await transport.nextRead();
    versionsRead.resolve(versionsResult);

    const pageRead = await transport.nextRead();
    pageRead.resolve(pageResult);

    const initial = await reading;
    assert.equal(
      initial.fleet.slots[0]?.hostLoad?.headroom,
      'green',
      'initial hostLoad from machines',
    );
    assert.equal(initial.fleet.machines?.[0]?.headroom, 'green', 'initial machines[0].headroom');

    const rpcsBefore = transport.requestCount;

    // Phase 2: push a machine entity — green → red.
    // Revert proof: removing the 'node' family handler in cache.ts → this waitFor times out.
    transport.publish({
      version: 1,
      epoch: EPOCH,
      changes: [
        {
          key: { family: 'node', nodeId: 'testmachine' },
          revision: 1,
          kind: 'updated',
          changedEntity: { family: 'node', entity: machineRed, version: 'v-m2' },
        },
      ],
    });

    const updated = await waitFor(
      cache,
      (d) => d.fleet.slots[0]?.hostLoad?.headroom === 'red',
      'machine push must update hostLoad',
    );
    assert.equal(transport.requestCount, rpcsBefore, 'zero new RPCs after machine entity push');
    assert.equal(updated.fleet.machines?.[0]?.headroom, 'red', 'machines array updated');
    assert.equal(updated.fleet.slots[0]?.hostLoad?.headroom, 'red', 'slot hostLoad updated');

    cache.dispose();
  },
);

test(
  'machine entity cache: old gateway (no entitySync) uses full read; machine entity push ignored',
  { timeout: 8000 },
  async () => {
    const slot = makeSlot();
    const machineGreen = makeMachineHealth('green');

    const transport = new ResourceCacheConformanceTransport(scope);
    transport.setConnection(legacyGatewayConnection(transport));
    const cache = createGatewayResourceCache({ transport });

    // Phase 1: plain fleet.status full read (no entitySync).
    const reading = waitFor(cache, (d) => d.fleet.slots.length > 0, 'initial full-read');

    const fullRead = await transport.nextRead();
    fullRead.resolve({
      fleet: {
        checkedAt: new Date().toISOString(),
        slots: [
          {
            ...slot,
            hostLoad: { cpuPercent: 10, memoryPercent: 20, diskPercent: 5, headroom: 'green' },
          },
        ],
        summary: {
          total: 1,
          ready: 1,
          busy: 0,
          held: 0,
          manual: 0,
          disabled: 0,
          blocked: 0,
          warmCount: 0,
        },
        machines: [machineGreen],
      },
    } satisfies FleetStatusResult);

    const initial = await reading;
    assert.equal(
      initial.fleet.slots[0]?.hostLoad?.headroom,
      'green',
      'initial hostLoad from full read',
    );

    const rpcsBefore = transport.requestCount;

    // Push a machine entity — the client must ignore it (no entitySync).
    transport.publish({
      version: 1,
      epoch: EPOCH,
      changes: [
        {
          key: { family: 'node', nodeId: 'testmachine' },
          revision: 1,
          kind: 'updated',
          changedEntity: { family: 'node', entity: makeMachineHealth('red'), version: 'v-m2' },
        },
      ],
    });

    await new Promise((r) => setTimeout(r, 50));
    assert.equal(
      transport.requestCount,
      rpcsBefore,
      'no RPCs triggered by machine push on legacy connection',
    );

    cache.dispose();
  },
);
