import assert from 'node:assert/strict';
import test from 'node:test';

import type { RuntimeCapabilityCatalogEntry, RuntimeCapabilityLease } from '@farmslot/protocol';

import {
  projectRuntimeCapabilityLeases,
  runtimeCapabilityRecoveryActions,
  runtimeCapabilityRetentionView,
} from './runtime-capabilities-panel-model.js';

const NOW_MS = Date.parse('2026-09-05T12:00:00.000Z');

function lease(
  id: string,
  state: RuntimeCapabilityLease['state'],
  ownerRunId: string,
  overrides: Partial<RuntimeCapabilityLease> = {},
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
    ...overrides,
  };
}

const entry: Pick<RuntimeCapabilityCatalogEntry, 'availability' | 'keepWarmMs'> = {
  availability: { state: 'available' },
  keepWarmMs: 600_000,
};

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

test('a released lease inside its keep-warm window reports a running provider', () => {
  // The bug ADR-054 names: the panel labelled this "Released", which reads as
  // "nothing is running" while the process is still up.
  const view = runtimeCapabilityRetentionView({
    entry,
    lease: lease('warm', 'released', 'run-1', {
      keepWarmUntil: '2026-09-05T12:10:00.000Z',
      releasedAt: '2026-09-05T11:59:00.000Z',
    }),
    planned: false,
    nowMs: NOW_MS,
  });

  assert.equal(view.leaseLabel, 'Released');
  assert.equal(view.observedState, 'running');
  assert.equal(view.warmUntil, '2026-09-05T12:10:00.000Z');
  assert.match(view.retentionReason, /keep-warm/);
});

test('a released lease past its keep-warm deadline reports a stopped provider', () => {
  const view = runtimeCapabilityRetentionView({
    entry,
    lease: lease('cold', 'released', 'run-1', { keepWarmUntil: '2026-09-05T11:00:00.000Z' }),
    planned: false,
    nowMs: NOW_MS,
  });

  assert.equal(view.observedState, 'stopped');
  assert.equal(view.warmUntil, undefined);
});

test('a cleanup failure is never reported as a stopped provider', () => {
  const view = runtimeCapabilityRetentionView({
    entry,
    lease: lease('failed', 'released', 'run-1', {
      keepWarmUntil: '2026-09-05T11:00:00.000Z',
      cleanupFailure: 'shutdown action exited 1',
    }),
    planned: false,
    nowMs: NOW_MS,
  });

  assert.equal(view.observedState, 'unhealthy');
  assert.equal(view.cleanupFailure, 'shutdown action exited 1');
});

test('an acquired lease with no health answer is not claimed to be running', () => {
  const view = runtimeCapabilityRetentionView({
    entry,
    lease: lease('held', 'acquired', 'run-1', { health: { state: 'unknown' } }),
    planned: false,
    nowMs: NOW_MS,
  });

  assert.equal(view.leaseLabel, 'Acquired');
  assert.equal(view.observedState, 'unknown');
});

test('an acquired, healthy lease reports a running provider', () => {
  const view = runtimeCapabilityRetentionView({
    entry,
    lease: lease('held', 'acquired', 'run-1'),
    planned: false,
    nowMs: NOW_MS,
  });

  assert.equal(view.observedState, 'running');
});

test('an unavailable capability with no lease explains why instead of saying stopped', () => {
  const view = runtimeCapabilityRetentionView({
    entry: { availability: { state: 'unavailable', reason: 'no simulator matches the slot' } },
    lease: undefined,
    planned: true,
    nowMs: NOW_MS,
  });

  assert.equal(view.leaseLabel, 'Planned');
  assert.equal(view.observedState, 'unknown');
  assert.equal(view.retentionReason, 'no simulator matches the slot');
});

test('acquire is offered only when an owner run and an available provider exist', () => {
  const idle = runtimeCapabilityRetentionView({
    entry,
    lease: undefined,
    planned: true,
    nowMs: NOW_MS,
  });

  assert.deepEqual(
    runtimeCapabilityRecoveryActions({
      view: idle,
      lease: undefined,
      hasOwnerRunId: true,
      available: true,
    }),
    ['acquire'],
  );
  assert.deepEqual(
    runtimeCapabilityRecoveryActions({
      view: idle,
      lease: undefined,
      hasOwnerRunId: false,
      available: true,
    }),
    [],
  );
  assert.deepEqual(
    runtimeCapabilityRecoveryActions({
      view: idle,
      lease: undefined,
      hasOwnerRunId: true,
      available: false,
    }),
    [],
  );
});

test('a warm provider with no lease can still be stopped', () => {
  const warm = lease('warm', 'released', 'run-1', { keepWarmUntil: '2026-09-05T12:10:00.000Z' });
  const view = runtimeCapabilityRetentionView({
    entry,
    lease: warm,
    planned: false,
    nowMs: NOW_MS,
  });

  assert.deepEqual(
    runtimeCapabilityRecoveryActions({
      view,
      lease: warm,
      hasOwnerRunId: true,
      available: true,
    }),
    ['acquire', 'release'],
  );
});

test('a held lease offers restart and stop, never a second acquire', () => {
  const held = lease('held', 'acquired', 'run-1');
  const view = runtimeCapabilityRetentionView({
    entry,
    lease: held,
    planned: false,
    nowMs: NOW_MS,
  });

  assert.deepEqual(
    runtimeCapabilityRecoveryActions({
      view,
      lease: held,
      hasOwnerRunId: true,
      available: true,
    }),
    ['restart', 'release'],
  );
});

test('a failed cleanup keeps the stop action reachable for a retry', () => {
  const broken = lease('broken', 'error', 'run-1', { cleanupFailure: 'shutdown timed out' });
  const view = runtimeCapabilityRetentionView({
    entry,
    lease: broken,
    planned: false,
    nowMs: NOW_MS,
  });

  assert.ok(
    runtimeCapabilityRecoveryActions({
      view,
      lease: broken,
      hasOwnerRunId: true,
      available: true,
    }).includes('release'),
  );
});
