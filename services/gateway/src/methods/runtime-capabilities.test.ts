import assert from 'node:assert/strict';
import test from 'node:test';

import type { RuntimeCapabilityLease } from '@farmslot/protocol';

import type { WarmSweepSummary } from '../runtime-capabilities/registry.js';

import { runtimeCapabilityStopWarm, stopWarmResultFromSummary } from './runtime-capabilities.js';

const PARAMS = { slotId: 'slot-a', capabilityId: 'metro' };

function lease(capabilityId: string): RuntimeCapabilityLease {
  return {
    id: `lease-${capabilityId}`,
    slotId: 'slot-a',
    project: 'test-project',
    capabilityId,
    owner: { runId: 'run-a' },
    state: 'released',
    referenceCount: 0,
    parameters: {},
    provenance: {
      project: 'test-project',
      providerId: capabilityId,
      version: '1',
      digest: `digest-${capabilityId}`,
    },
    health: { state: 'unknown' },
    dependencyLeaseIds: [],
    updatedAt: '2026-09-05T00:00:00.000Z',
  };
}

function summary(overrides: Partial<WarmSweepSummary> = {}): WarmSweepSummary {
  return {
    selected: [],
    deferred: [],
    released: [],
    stillHeld: [],
    failures: [],
    effects: [],
    ...overrides,
  };
}

test('a stopped warm provider reports stopped with its declared effects', () => {
  const result = stopWarmResultFromSummary(
    PARAMS,
    summary({ released: [lease('metro')], effects: ['stop metro bundler'] }),
  );
  assert.deepEqual(result, {
    slotId: 'slot-a',
    capabilityId: 'metro',
    ok: true,
    outcome: 'stopped',
    observedState: 'stopped',
    effects: ['stop metro bundler'],
  });
});

test('a deferred warm provider is reported running, with the reason', () => {
  const result = stopWarmResultFromSummary(PARAMS, summary({ deferred: [lease('metro')] }));
  assert.equal(result.ok, false);
  assert.equal(result.outcome, 'deferred');
  assert.equal(result.observedState, 'running');
  assert.match(result.reason ?? '', /still needed by an active or warm dependent/);

  // A provider another lease still owns is also not stoppable here.
  const held = stopWarmResultFromSummary(PARAMS, summary({ stillHeld: [lease('metro')] }));
  assert.equal(held.outcome, 'deferred');
  assert.equal(held.observedState, 'running');
  assert.match(held.reason ?? '', /still held by another lease/);
});

test('a cleanup failure is never reported as stopped', () => {
  const result = stopWarmResultFromSummary(
    PARAMS,
    summary({
      failures: [
        { leaseId: 'lease-metro', capabilityId: 'metro', reason: 'metro shutdown exited 1' },
      ],
    }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.outcome, 'failed');
  assert.notEqual(result.observedState, 'stopped');
  assert.equal(result.observedState, 'unhealthy');
  assert.equal(result.cleanupFailure, 'metro shutdown exited 1');
  assert.deepEqual(result.effects, []);
});

test('a capability that was never warm is a successful no-op', () => {
  const result = stopWarmResultFromSummary(PARAMS, summary(), []);
  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'not-warm');
  assert.equal(result.observedState, 'stopped');
  assert.match(result.reason ?? '', /nothing is keeping 'metro' warm on slot-a/);
});

test('not-warm does not mean stopped when an active lease still holds it', () => {
  const held: RuntimeCapabilityLease = { ...lease('metro'), state: 'acquired' };
  const result = stopWarmResultFromSummary(PARAMS, summary(), [held]);
  assert.equal(result.outcome, 'not-warm');
  assert.equal(
    result.observedState,
    'running',
    'an active lease holds the provider, so it is not stopped',
  );
  assert.match(result.reason ?? '', /held by an active lease/);
});

test('a failure on another capability does not change this verdict', () => {
  const result = stopWarmResultFromSummary(
    PARAMS,
    summary({
      released: [lease('metro')],
      effects: ['stop metro bundler'],
      failures: [{ leaseId: 'lease-other', capabilityId: 'browser', reason: 'browser stuck' }],
    }),
  );
  assert.equal(result.outcome, 'stopped');
  assert.equal(result.cleanupFailure, undefined);
});

test('stopWarm rejects malformed params before touching the registry', async () => {
  await assert.rejects(
    runtimeCapabilityStopWarm({ slotId: '  ', capabilityId: 'metro' }),
    /slotId must be a non-empty string/,
  );
  await assert.rejects(
    runtimeCapabilityStopWarm({ slotId: 'slot-a', capabilityId: '' }),
    /capabilityId must be a non-empty string/,
  );
});

test('a retry after a failed cleanup reports the unresolved failure, not stopped', () => {
  // The sweep only selects `released` leases, so a retry finds nothing warm.
  // The error lease is what records that the provider may still be running.
  const failed: RuntimeCapabilityLease = {
    ...lease('metro'),
    state: 'error',
    cleanupFailure: 'metro shutdown exited 1',
  };
  const result = stopWarmResultFromSummary(PARAMS, summary(), [failed]);
  assert.equal(result.ok, false);
  assert.equal(result.outcome, 'failed');
  assert.notEqual(result.observedState, 'stopped');
  assert.equal(result.observedState, 'unknown');
  assert.equal(result.cleanupFailure, 'metro shutdown exited 1');
  assert.match(result.reason ?? '', /unresolved cleanup/);
});

test('an error lease without a stored failure does not mask a real verdict', () => {
  const stale: RuntimeCapabilityLease = { ...lease('metro'), state: 'error' };
  const result = stopWarmResultFromSummary(PARAMS, summary(), [stale]);
  assert.equal(result.outcome, 'not-warm');
});
