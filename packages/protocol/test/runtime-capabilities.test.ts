import assert from 'node:assert/strict';
import test from 'node:test';

import {
  Events,
  Methods,
  type RuntimeCapabilityAcquireResult,
  type RuntimeCapabilityCatalogEntry,
  RuntimeCapabilityMethods,
  type RuntimeCapabilityPressureConflict,
  type RuntimeCapabilityProofPlan,
} from '../src/index.js';

test('runtime capability methods and lifecycle event use the shared protocol registry', () => {
  assert.deepEqual(RuntimeCapabilityMethods, {
    list: 'runtime.capability.list',
    acquire: 'runtime.capability.acquire',
    release: 'runtime.capability.release',
    status: 'runtime.capability.status',
  });
  assert.equal(Methods.RUNTIME_CAPABILITY_ACQUIRE, RuntimeCapabilityMethods.acquire);
  assert.equal(Events.RUNTIME_CAPABILITY_LIFECYCLE, 'runtime.capability.lifecycle');
});

test('catalog, proof plan, pressure, and acquire result shapes compose without private copies', () => {
  const entry: RuntimeCapabilityCatalogEntry = {
    id: 'browser-cdp',
    project: 'farmslot-farm',
    label: 'Browser / CDP',
    version: '1',
    sharePolicy: 'exclusive',
    cost: { class: 'high', resources: [{ id: 'cdp', access: 'exclusive', kind: 'port' }] },
    actions: {
      acquire: { kind: 'slot-action', actionId: 'browser-start' },
      health: { kind: 'slot-action', actionId: 'browser-health' },
      release: { kind: 'slot-action', actionId: 'browser-stop' },
    },
    releaseEffects: ['stop browser'],
    provenance: {
      project: 'farmslot-farm',
      providerId: 'browser-cdp',
      version: '1',
      digest: 'digest',
    },
    availability: { state: 'available' },
  };
  const plan: RuntimeCapabilityProofPlan = {
    version: 1,
    slotId: 'slot-a',
    ownerRunId: 'run-a',
    createdAt: '2026-08-11T00:00:00.000Z',
    requirements: [{ capabilityId: entry.id, reason: 'visual AC', mode: 'visual' }],
  };
  const pressure: RuntimeCapabilityPressureConflict = {
    kind: 'host-pressure',
    severity: 'critical',
    reason: 'memory pressure',
    queued: true,
  };
  const result: RuntimeCapabilityAcquireResult = { ok: false, conflict: pressure };

  assert.equal(plan.requirements[0]?.capabilityId, entry.provenance.providerId);
  assert.equal(result.ok, false);
  assert.equal(result.conflict.kind, 'host-pressure');
});
