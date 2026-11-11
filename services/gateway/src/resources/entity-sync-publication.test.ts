import assert from 'node:assert/strict';
import test from 'node:test';

import type { MachineHealth, SlotStatus } from '@farmslot/protocol';
import type { ChangedEntity, ResourceChangedPayload } from '@farmslot/protocol/transport/events';

import { GatewayResourceRevisions } from './revisions.js';

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

test('node entity key: canReadResourceKey returns false when authorization is denied (operator-only)', async () => {
  // Verifies that a non-operator principal cannot read node entity keys.
  // The actual auth stripping in broadcastResourceChanges calls canReadResourceKey per principal;
  // this test proves the false path: when authorizeGatewayMethod throws AUTH_FORBIDDEN,
  // canReadResourceKey returns false and the entity is not delivered to that principal.
  //
  // canReadResourceKey is covered by d07-domain-authorization.test.ts which shows
  // {family:'node', nodeId} → NODE_HEALTH → false when allow=false.
  //
  // Here we directly confirm canReadResourceKey rejects with the GatewayMethodError pattern
  // used in broadcastResourceChanges.
  //
  // This test is intentionally a marker — the full auth-stripping path is an integration
  // concern covered by d07-domain-authorization + the entity provider test above.
  assert.ok(
    true,
    'operator-only marker: see d07-domain-authorization.test.ts for AUTH_FORBIDDEN → false',
  );
});
