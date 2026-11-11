import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import type { MachineHealth, SlotStatus } from '@farmslot/protocol';
import type { ResourceKey } from '@farmslot/protocol/client-cache';
import type { ChangedEntity, ResourceChangedPayload } from '@farmslot/protocol/transport/events';

import { GatewayMethodError } from '../core/method-error.js';

// Mock authorizeGatewayMethod so the auth test below is self-contained and
// doesn't depend on a real filesystem auth-runtime.
// The mock is stateful: set `mockAuthAllow` to control per-test behaviour.
let mockAuthAllow = true;
mock.module('../security/authorization.js', {
  namedExports: {
    authorizeGatewayMethod: (): void => {
      if (!mockAuthAllow) throw new GatewayMethodError('AUTH_FORBIDDEN', 'operator-only resource');
    },
  },
});

const { GatewayResourceRevisions } = await import('./revisions.js');
const { canReadResourceKey } = await import('./authorization.js');

const slotKey = { family: 'slot', slotId: 'macwork-01' } as const;
const collectionKey = { family: 'slots', scope: 'farm' } as const;

const fakeEntity: SlotStatus = {
  slot: 'macwork-01',
  machine: 'macwork',
  platform: 'macos',
  project: 'p',
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
const fakeChanged: ChangedEntity = {
  family: 'slot',
  entity: fakeEntity,
  version: 'abc123abc123abcd',
};

test('publish attaches changedEntity from registered provider for per-entity keys', async () => {
  const revisions = new GatewayResourceRevisions();
  const packets: ResourceChangedPayload[] = [];
  revisions.setPublisher((p) => packets.push(p));
  revisions.setEntityProvider('slot', (key) => {
    if (key.family === 'slot' && 'slotId' in key) return fakeChanged;
    return undefined;
  });
  try {
    revisions.advance(slotKey);
    await Promise.resolve();
    assert.equal(packets.length, 1);
    const change = packets[0].changes[0];
    assert.deepEqual(change.changedEntity, fakeChanged);
  } finally {
    revisions.dispose();
  }
});

test('publish does not attach changedEntity for collection keys (provider registered for per-entity family only)', async () => {
  const revisions = new GatewayResourceRevisions();
  const packets: ResourceChangedPayload[] = [];
  revisions.setPublisher((p) => packets.push(p));
  // Provider registered for 'slot' family, not 'slots' — no provider matches collection key.
  revisions.setEntityProvider('slot', () => fakeChanged);
  try {
    revisions.advance(collectionKey); // { family: 'slots', scope: 'farm' }
    await Promise.resolve();
    assert.equal(packets.length, 1);
    const change = packets[0].changes[0];
    assert.ok(!change.changedEntity, 'collection key family has no provider → no changedEntity');
  } finally {
    revisions.dispose();
  }
});

test('advanceMembership attaches membershipRevision to collection key notification', async () => {
  const revisions = new GatewayResourceRevisions();
  const packets: ResourceChangedPayload[] = [];
  revisions.setPublisher((p) => packets.push(p));
  try {
    revisions.advanceMembership(collectionKey);
    await Promise.resolve();
    const change = packets[0].changes[0];
    assert.equal(change.membershipRevision, 1);
  } finally {
    revisions.dispose();
  }
});

test('plain advance does not set membershipRevision', async () => {
  const revisions = new GatewayResourceRevisions();
  const packets: ResourceChangedPayload[] = [];
  revisions.setPublisher((p) => packets.push(p));
  try {
    revisions.advance(collectionKey);
    await Promise.resolve();
    const change = packets[0].changes[0];
    assert.ok(change.membershipRevision === undefined, 'advance must not set membershipRevision');
  } finally {
    revisions.dispose();
  }
});

test('advanceMembership increments membershipRevision monotonically', async () => {
  const revisions = new GatewayResourceRevisions();
  const packets: ResourceChangedPayload[] = [];
  revisions.setPublisher((p) => packets.push(p));
  try {
    revisions.advanceMembership(collectionKey);
    await Promise.resolve();
    revisions.advanceMembership(collectionKey);
    await Promise.resolve();
    const revList = packets.flatMap((p) => p.changes).map((c) => c.membershipRevision);
    assert.deepEqual(revList, [1, 2]);
  } finally {
    revisions.dispose();
  }
});

test('publish does not attach changedEntity for deleted per-entity keys', async () => {
  const revisions = new GatewayResourceRevisions();
  const packets: ResourceChangedPayload[] = [];
  revisions.setPublisher((p) => packets.push(p));
  revisions.setEntityProvider('slot', () => fakeChanged);
  try {
    revisions.advance(slotKey, 'deleted');
    await Promise.resolve();
    const change = packets[0].changes[0];
    assert.equal(change.kind, 'deleted');
    assert.ok(!change.changedEntity, 'deleted key must not carry changedEntity');
  } finally {
    revisions.dispose();
  }
});

// ---- Machine health entity publish (ADR-071 Amendment 3 carry-along item a) ----

const realisticMachineHealth: MachineHealth = {
  machine: 'macwork',
  online: true,
  headroom: 'green',
  capacity: { maxSlots: 4, activeSlots: 1, cpuCores: 10 },
  system: {
    cpuPercent: 12.5,
    memoryPercent: 48.3,
    memoryUsedGb: 15.4,
    memoryTotalGb: 32,
    diskPercent: 61.0,
    loadAvg1: 2.1,
    loadAvg5: 1.8,
    cpuCores: 10,
    collectedAt: '2026-11-12T05:00:00.000Z',
  },
  providerCliHealth: [
    {
      root: '/Users/deeeed/.local',
      packageName: 'farmslot',
      expectedVersion: '1.9.0',
      ok: true,
      status: 'verified',
      checkedAt: '2026-11-12T05:00:00.000Z',
      binaries: [
        {
          name: 'farmslot',
          path: '/Users/deeeed/.local/bin/farmslot',
          scope: 'user',
          version: '1.9.0',
        },
      ],
    },
  ],
  workerCliHealth: { ok: true, checkedAt: '2026-11-12T05:00:00.000Z' },
};

// Item (d): measured bytes of one realistic MachineHealth push over JSON.
// Computed inline: JSON.stringify(realisticMachineHealth).length bytes.
const machineHealthJsonBytes = JSON.stringify(realisticMachineHealth).length;

test('health sample through the real publish path produces resource.changed for node key with full MachineHealth and version', async () => {
  const nodeKey = { family: 'node', nodeId: 'macwork' } as const;
  const revisions = new GatewayResourceRevisions();
  const packets: ResourceChangedPayload[] = [];
  revisions.setPublisher((p) => packets.push(p));

  // Register node entity provider — mirrors what server.ts does for the 'node' family.
  const version = Buffer.from(JSON.stringify(realisticMachineHealth).slice(0, 16))
    .toString('hex')
    .slice(0, 16);
  revisions.setEntityProvider('node', (key) => {
    if (key.family !== 'node' || !('nodeId' in key)) return undefined;
    return { family: 'node', entity: realisticMachineHealth, version };
  });

  try {
    revisions.advance(nodeKey);
    await Promise.resolve();
    assert.equal(packets.length, 1, 'one packet published');
    const change = packets[0].changes[0];
    assert.ok(change.changedEntity, 'changedEntity attached for node key');
    assert.equal(change.changedEntity.family, 'node', 'entity family is node');
    assert.deepEqual(
      change.changedEntity.entity,
      realisticMachineHealth,
      'full MachineHealth in entity',
    );
    assert.ok(
      typeof change.changedEntity.version === 'string' && change.changedEntity.version.length > 0,
      'version is a non-empty string',
    );
    // Item (d): one realistic MachineHealth push is machineHealthJsonBytes bytes over JSON.
    assert.ok(machineHealthJsonBytes > 0, `MachineHealth JSON bytes: ${machineHealthJsonBytes}`);
  } finally {
    revisions.dispose();
  }
});

test('node entity key: canReadResourceKey returns false when authorization is denied', () => {
  // Proves that a principal denied NODE_HEALTH cannot read the {family:'node'} key.
  // broadcastResourceChanges in server.ts calls canReadResourceKey per principal and
  // strips the changedEntity when this returns false.
  mockAuthAllow = false;
  try {
    const nodeKey: ResourceKey = { family: 'node', nodeId: 'macwork' };
    assert.equal(
      canReadResourceKey(
        {} as Parameters<typeof canReadResourceKey>[0],
        {} as Parameters<typeof canReadResourceKey>[1],
        nodeKey,
      ),
      false,
      'canReadResourceKey must return false for node key when auth is denied',
    );
  } finally {
    mockAuthAllow = true;
  }
});
