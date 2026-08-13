import assert from 'node:assert/strict';
import test from 'node:test';

import type { RuntimeCapabilityLease } from '@farmslot/protocol';

import { projectRuntimeCapabilityLeases } from './runtime-capabilities-panel-model.js';

function lease(
  id: string,
  state: RuntimeCapabilityLease['state'],
  ownerRunId: string,
): RuntimeCapabilityLease {
  return {
    id,
    slotId: 'slot-a',
    project: 'farmslot-farm',
    capabilityId: 'browser-cdp',
    owner: { runId: ownerRunId },
    state,
    referenceCount: 1,
    parameters: {},
    provenance: {
      project: 'farmslot-farm',
      providerId: 'browser-cdp',
      version: '1',
      digest: 'browser-digest',
    },
    health: { state: state === 'acquired' ? 'healthy' : 'unknown' },
    dependencyLeaseIds: [],
    updatedAt: '2026-08-14T00:00:00.000Z',
  };
}

test('provider holder remains primary when a newer queued reservation exists', () => {
  const holder = lease('holder', 'acquired', 'run-holder');
  const queued = lease('queued', 'queued', 'run-queued');

  const projection = projectRuntimeCapabilityLeases([holder, queued]);

  assert.equal(projection.providerHolder?.owner.runId, 'run-holder');
  assert.deepEqual(
    projection.queuedReservations.map((reservation) => reservation.owner.runId),
    ['run-queued'],
  );
});
