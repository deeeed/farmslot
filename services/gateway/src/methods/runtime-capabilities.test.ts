import assert from 'node:assert/strict';
import test from 'node:test';

import type { RuntimeCapabilityLease } from '@farmslot/protocol';

import type { WarmSweepSummary } from '../runtime-capabilities/registry.js';

import {
  assertDeviceTargetAvailable,
  type DeviceTargetGuardDeps,
  runtimeCapabilityStopWarm,
  stopWarmResultFromSummary,
} from './runtime-capabilities.js';

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

// ── ADR-054 item 3: the cross-slot device guard, at the methods level ─────────

function guardLease(
  slotId: string,
  capabilityId: string,
  runId: string,
  parameters: Record<string, unknown> = {},
): RuntimeCapabilityLease {
  return { ...lease(capabilityId), id: `lease-${slotId}`, slotId, owner: { runId }, parameters };
}

function guardDeps(
  slots: Record<string, { machine: string; simulator: string }>,
): DeviceTargetGuardDeps {
  return {
    loadSlotVars: async (slotId) => {
      const slot = slots[slotId];
      if (!slot) throw new Error(`unknown slot ${slotId}`);
      return { machine: slot.machine, resourceVars: { simulator: slot.simulator } };
    },
    catalogForSlot: async () => ({
      capabilities: [
        {
          id: 'ios-simulator',
          cost: { class: 'high', resources: [{ id: 'sim', access: 'exclusive', kind: 'device' }] },
        },
      ] as never,
    }),
  };
}

test('a same-named device on another machine reaches the guard and is skipped', async () => {
  // The pool reuses `fs-1` on macpro and macwork. Before the holder carried its
  // OWN machine, every holder was stamped with the acquirer's, so the machine
  // filter could never fire and an ordinary acquire on one machine was refused
  // because another machine ran a same-named simulator.
  const deps = guardDeps({
    'macpro-ff-1': { machine: 'macpro', simulator: 'fs-1' },
    'macwork-ff-1': { machine: 'macwork', simulator: 'fs-1' },
  });
  const refusal = await assertDeviceTargetAvailable(
    {
      slotId: 'macpro-ff-1',
      capabilityId: 'ios-simulator',
      ownerRunId: 'run-a',
      parameters: {},
      claimsDevice: true,
      activeLeases: [guardLease('macwork-ff-1', 'ios-simulator', 'run-b')],
    },
    deps,
  );
  assert.equal(refusal, null, 'two machines, two physically distinct simulators');
});

test('a same-named device on the SAME machine is still refused, naming that machine', async () => {
  const deps = guardDeps({
    'macwork-ff-4': { machine: 'macwork', simulator: 'fs-1' },
    'macwork-ff-1': { machine: 'macwork', simulator: 'fs-1' },
  });
  const refusal = await assertDeviceTargetAvailable(
    {
      slotId: 'macwork-ff-4',
      capabilityId: 'ios-simulator',
      ownerRunId: 'run-a',
      parameters: {},
      claimsDevice: true,
      activeLeases: [guardLease('macwork-ff-1', 'ios-simulator', 'run-b')],
    },
    deps,
  );
  assert.match(refusal ?? '', /slot 'macwork-ff-1' on macwork/);
  assert.match(refusal ?? '', /run-b/);
});

test('an unreadable foreign slot refuses rather than failing open', async () => {
  const deps = guardDeps({ 'macwork-ff-4': { machine: 'macwork', simulator: 'fs-1' } });
  const refusal = await assertDeviceTargetAvailable(
    {
      slotId: 'macwork-ff-4',
      capabilityId: 'ios-simulator',
      ownerRunId: 'run-a',
      parameters: {},
      claimsDevice: true,
      activeLeases: [guardLease('macwork-ff-9', 'ios-simulator', 'run-b')],
    },
    deps,
  );
  assert.match(refusal ?? '', /cannot verify device target against slot 'macwork-ff-9'/);
});

test('a capability that claims no device and names none is not guarded at all', async () => {
  let reads = 0;
  const refusal = await assertDeviceTargetAvailable(
    {
      slotId: 'macwork-ff-4',
      capabilityId: 'browser-cdp',
      ownerRunId: 'run-a',
      parameters: {},
      claimsDevice: false,
      activeLeases: [],
    },
    {
      loadSlotVars: async () => {
        reads += 1;
        throw new Error('should not be read');
      },
      catalogForSlot: async () => ({ capabilities: [] }),
    },
  );
  assert.equal(refusal, null);
  assert.equal(reads, 0, 'no slot config is read for a capability with nothing to guard');
});
