import assert from 'node:assert/strict';
import test from 'node:test';

import type { RuntimeCapabilityCatalogEntry } from '@farmslot/protocol';

import { evaluateRuntimeCapabilityAdmission } from './admission.js';

/** Today's enforcing behaviour is now opt-in; every enforcing case says so. */
const refuse = (queueOnPressure = false) => ({ mode: 'refuse' as const, queueOnPressure });

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

test('critical pressure rejects or queues expensive acquisition when the project opts in', () => {
  const pressure = {
    severity: 'critical' as const,
    reason: 'memory headroom critical',
    machine: 'macwork',
    retryAfterMs: 15000,
  };
  const rejected = evaluateRuntimeCapabilityAdmission(capability('high'), pressure, refuse());
  assert.deepEqual(rejected, {
    kind: 'host-pressure',
    severity: 'critical',
    reason: 'memory headroom critical',
    machine: 'macwork',
    queued: false,
    retryAfterMs: 15000,
  });
  const queued = evaluateRuntimeCapabilityAdmission(capability('medium'), pressure, refuse(true));
  assert.equal(queued?.kind, 'host-pressure');
  assert.equal(queued?.kind === 'host-pressure' && queued.queued, true);
});

test('admission is policy-only and never receives or returns another run to cancel', () => {
  const existingRun = { id: 'run-a', status: 'working' };
  const result = evaluateRuntimeCapabilityAdmission(
    capability('high'),
    { severity: 'critical', reason: 'cpu pressure' },
    refuse(true),
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
      refuse(true),
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
    evaluateRuntimeCapabilityAdmission(capability('low'), { severity: 'critical' }, refuse()),
    null,
  );
  assert.equal(
    evaluateRuntimeCapabilityAdmission(capability('high'), { severity: 'warn' }, refuse()),
    null,
  );
});

test('the default off mode admits under critical pressure and reports it as advisory', () => {
  const advisory = evaluateRuntimeCapabilityAdmission(
    capability('high'),
    {
      severity: 'critical',
      reason: 'Load average 118 is above 1.5x 12 cores.',
      machine: 'macwork',
    },
    { mode: 'off', queueOnPressure: false },
  );
  assert.deepEqual(advisory, {
    kind: 'host-pressure',
    severity: 'critical',
    reason: 'Load average 118 is above 1.5x 12 cores.',
    machine: 'macwork',
    queued: false,
    enforced: false,
  });
});

test('an unenforced conflict never queues, even when the caller asked to queue', () => {
  const advisory = evaluateRuntimeCapabilityAdmission(
    capability('medium'),
    { severity: 'critical', machine: 'macwork' },
    { mode: 'off', queueOnPressure: true },
  );
  assert.equal(advisory?.kind === 'host-pressure' && advisory.queued, false);
  assert.equal(advisory?.kind === 'host-pressure' && advisory.enforced, false);
});

test('queue mode queues a medium-cost acquire the caller did not ask to queue', () => {
  const queued = evaluateRuntimeCapabilityAdmission(
    capability('medium'),
    { severity: 'critical', machine: 'macwork' },
    { mode: 'queue', queueOnPressure: false },
  );
  assert.equal(queued?.kind === 'host-pressure' && queued.queued, true);
  assert.equal(queued?.kind === 'host-pressure' && queued.enforced, undefined);
});

test('machine unavailability is refused in every mode, including off', () => {
  assert.deepEqual(
    evaluateRuntimeCapabilityAdmission(
      capability('medium'),
      { severity: 'ok', machine: 'runner-a', unavailableReason: 'Machine is offline.' },
      { mode: 'off', queueOnPressure: false },
    ),
    { kind: 'unavailable', capabilityId: 'medium-capability', reason: 'Machine is offline.' },
  );
});
