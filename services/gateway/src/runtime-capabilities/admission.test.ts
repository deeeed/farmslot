import assert from 'node:assert/strict';
import test from 'node:test';

import type { RuntimeCapabilityCatalogEntry } from '@farmslot/protocol';

import { evaluateRuntimeCapabilityAdmission } from './admission.js';

function capability(
  cost: RuntimeCapabilityCatalogEntry['cost']['class'],
): RuntimeCapabilityCatalogEntry {
  return {
    id: `${cost}-capability`,
    project: 'test',
    label: cost,
    version: '1',
    sharePolicy: 'exclusive',
    cost: { class: cost, resources: [] },
    actions: {
      acquire: { kind: 'slot-action', actionId: 'acquire' },
      health: { kind: 'slot-action', actionId: 'health' },
      release: { kind: 'slot-action', actionId: 'release' },
    },
    releaseEffects: [],
    provenance: { project: 'test', providerId: cost, version: '1', digest: cost },
    availability: { state: 'available' },
  };
}

test('critical pressure rejects or queues expensive acquisition with a typed reason', () => {
  const pressure = {
    severity: 'critical' as const,
    reason: 'memory headroom critical',
    machine: 'macwork',
    retryAfterMs: 15000,
  };
  const rejected = evaluateRuntimeCapabilityAdmission(capability('high'), pressure, false);
  assert.deepEqual(rejected, {
    kind: 'host-pressure',
    severity: 'critical',
    reason: 'memory headroom critical',
    machine: 'macwork',
    queued: false,
    retryAfterMs: 15000,
  });
  const queued = evaluateRuntimeCapabilityAdmission(capability('medium'), pressure, true);
  assert.equal(queued?.kind, 'host-pressure');
  assert.equal(queued?.kind === 'host-pressure' && queued.queued, true);
});

test('admission is policy-only and never receives or returns another run to cancel', () => {
  const existingRun = { id: 'run-a', status: 'working' };
  const result = evaluateRuntimeCapabilityAdmission(
    capability('high'),
    { severity: 'critical', reason: 'cpu pressure' },
    true,
  );
  assert.deepEqual(existingRun, { id: 'run-a', status: 'working' });
  assert.equal('cancelledRunId' in (result ?? {}), false);
  assert.equal(result?.kind, 'host-pressure');
});

test('unavailable machine health fails without creating retryable pressure', () => {
  assert.deepEqual(
    evaluateRuntimeCapabilityAdmission(
      capability('medium'),
      {
        severity: 'critical',
        machine: 'runner-a',
        unavailableReason: 'Machine is offline.',
      },
      true,
    ),
    {
      kind: 'unavailable',
      capabilityId: 'medium-capability',
      reason: 'Machine is offline.',
    },
  );
});

test('low-cost capabilities remain admissible and warning pressure does not block', () => {
  assert.equal(
    evaluateRuntimeCapabilityAdmission(capability('low'), { severity: 'critical' }, false),
    null,
  );
  assert.equal(
    evaluateRuntimeCapabilityAdmission(capability('high'), { severity: 'warn' }, false),
    null,
  );
});
