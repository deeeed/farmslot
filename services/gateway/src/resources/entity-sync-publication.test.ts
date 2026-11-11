import assert from 'node:assert/strict';
import test from 'node:test';

import type { SlotStatus } from '@farmslot/protocol';
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
