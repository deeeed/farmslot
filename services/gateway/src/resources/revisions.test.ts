import assert from 'node:assert/strict';
import test from 'node:test';

import type { ResourceChangedPayload } from '@farmslot/protocol/transport/events';

import { GatewayResourceRevisions, readWithResourceState } from './revisions.js';

const key = { family: 'sources', scope: 'farm' } as const;

test('the production read wrapper samples before a writer can advance the readable data', async () => {
  const revisions = new GatewayResourceRevisions();
  try {
    const response = await readWithResourceState(
      [key],
      async () => {
        revisions.advance(key);
        revisions.advance(key);
        return { readableRevision: revisions.revision(key) };
      },
      revisions,
    );
    assert.equal(response.payload.readableRevision, 2);
    assert.equal(response.resourceState.dependencies[0].revision, 0);
    assert.equal(response.resourceState.epoch, revisions.epoch);
  } finally {
    revisions.dispose();
  }
});

test('per-key counters and burst coalescing publish the latest committed revisions', async () => {
  const revisions = new GatewayResourceRevisions();
  const packets: ResourceChangedPayload[] = [];
  revisions.setPublisher((packet) => packets.push(packet));
  try {
    revisions.advance(key);
    revisions.advance(key);
    const other = { family: 'run', runId: 'r' } as const;
    assert.equal(revisions.revision(other), 0);
    revisions.advance(other, 'deleted');
    await Promise.resolve();
    assert.equal(packets.length, 2);
    assert.deepEqual(
      packets.flatMap((packet) => packet.changes),
      [
        { key, revision: 2, kind: 'updated' },
        { key: other, revision: 1, kind: 'deleted' },
      ],
    );
    assert.notEqual(new GatewayResourceRevisions().epoch, revisions.epoch);
  } finally {
    revisions.dispose();
  }
});

test('one deadline updates its current key cohort and coalesces publication per family', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const revisions = new GatewayResourceRevisions();
  const packets: ResourceChangedPayload[] = [];
  revisions.setPublisher((packet) => packets.push(packet));
  const farm = { family: 'slots', scope: 'farm' } as const;
  const former = { family: 'slot', slotId: 'former' } as const;
  const current = { family: 'slot', slotId: 'current' } as const;
  try {
    revisions.scheduleInvalidations('fleet-status', [farm, former], 1100);
    revisions.scheduleInvalidations('fleet-status', [farm, current], 1100);
    t.mock.timers.tick(100);
    await Promise.resolve();
    assert.equal(revisions.revision(former), 0);
    assert.equal(revisions.revision(current), 1);
    assert.equal(revisions.revision(farm), 1);
    assert.equal(packets.length, 2);
    revisions.scheduleInvalidations('fleet-status', [farm, current], 1200);
    revisions.scheduleInvalidations('fleet-status', [], undefined);
    t.mock.timers.tick(100);
    assert.equal(revisions.revision(current), 1);
  } finally {
    revisions.dispose();
  }
});
