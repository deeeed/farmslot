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

test('the default off mode admits under critical pressure and reports a distinct advisory', () => {
  const advisory = evaluateRuntimeCapabilityAdmission(
    capability('high'),
    {
      severity: 'critical',
      reason: 'Load average 118 is above 1.5x 12 cores.',
      machine: 'macwork',
    },
    { mode: 'off', queueOnPressure: false },
  );
  // A DIFFERENT kind, not a conflict carrying a flag: a client matching
  // 'host-pressure' cannot paint this admitted acquire as a block.
  assert.equal(advisory?.kind, 'host-pressure-advisory');
  if (advisory?.kind !== 'host-pressure-advisory') return;
  const { observedAt, ...rest } = advisory;
  assert.deepEqual(rest, {
    kind: 'host-pressure-advisory',
    severity: 'critical',
    reason: 'Load average 118 is above 1.5x 12 cores.',
    machine: 'macwork',
  });
  // It never carries the fields a refusal is acted on by.
  assert.equal('queued' in advisory, false, 'an advisory has nothing to queue behind');
  assert.equal('retryAfterMs' in advisory, false);
  // The advisory is pinned to a lease and never refreshed, so it must say when
  // it was read.
  assert.ok(
    Date.parse(observedAt ?? '') > 0,
    'an unenforced advisory carries the time it was observed',
  );
});

test('an enforced refusal stays a host-pressure conflict with no advisory fields', () => {
  const refused = evaluateRuntimeCapabilityAdmission(
    capability('high'),
    { severity: 'critical', machine: 'macwork' },
    refuse(),
  );
  assert.equal(refused?.kind, 'host-pressure');
  assert.equal('observedAt' in (refused ?? {}), false);
});

test('an unenforced conflict never queues, even when the caller asked to queue', () => {
  const advisory = evaluateRuntimeCapabilityAdmission(
    capability('medium'),
    { severity: 'critical', machine: 'macwork' },
    { mode: 'off', queueOnPressure: true },
  );
  // Nothing to queue behind: an advisory refuses nothing in the first place.
  assert.equal(advisory?.kind, 'host-pressure-advisory');
  assert.equal('queued' in (advisory ?? {}), false);
});

test('queue mode queues a medium-cost acquire the caller did not ask to queue', () => {
  const queued = evaluateRuntimeCapabilityAdmission(
    capability('medium'),
    { severity: 'critical', machine: 'macwork' },
    { mode: 'queue', queueOnPressure: false },
  );
  assert.equal(queued?.kind === 'host-pressure' && queued.queued, true);
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
