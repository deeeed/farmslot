import assert from 'node:assert/strict';
import test from 'node:test';

import {
  observedStateForLease,
  type RuntimeCapabilityCatalogEntry,
  type RuntimeCapabilityLease,
} from '@farmslot/protocol';

import {
  projectRuntimeCapabilityLeases,
  runtimeCapabilityRecoveryActions,
  runtimeCapabilityRetentionView,
  runtimeCapabilityWarmStopUnavailable,
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

test('an elapsed warm deadline is unknown, not stopped, until the Gateway says so', () => {
  // The deadline is a schedule, not an outcome: the sweeper may not have run.
  // Slot View used to decide `stopped` here, which labels a live provider dead.
  const view = runtimeCapabilityRetentionView({
    entry,
    lease: lease('cold', 'released', 'run-1', { keepWarmUntil: '2026-09-05T11:00:00.000Z' }),
    planned: false,
    nowMs: NOW_MS,
  });

  assert.equal(view.observedState, 'unknown');
  assert.equal(view.warmUntil, undefined);
  assert.match(view.retentionReason, /has not yet confirmed/);
});

test('a released lease with no warm window at all is stopped', () => {
  const view = runtimeCapabilityRetentionView({
    entry,
    lease: lease('done', 'released', 'run-1'),
    planned: false,
    nowMs: NOW_MS,
  });

  assert.equal(view.observedState, 'stopped');
});

test('the observed state matches the Gateway derivation exactly', () => {
  // One shared function decides this; the panel only puts words around it.
  const cases: Array<[RuntimeCapabilityLease | undefined, string]> = [
    [undefined, 'stopped'],
    [lease('a', 'acquired', 'run-1'), 'running'],
    [lease('b', 'acquired', 'run-1', { health: { state: 'unhealthy' } }), 'unhealthy'],
    [lease('c', 'acquiring', 'run-1'), 'transitioning'],
    [lease('d', 'queued', 'run-1'), 'transitioning'],
    [lease('e', 'error', 'run-1', { cleanupFailure: 'boom' }), 'unhealthy'],
    [lease('f', 'error', 'run-1'), 'unknown'],
  ];
  for (const [candidate, expected] of cases) {
    assert.equal(
      runtimeCapabilityRetentionView({ entry, lease: candidate, planned: false, nowMs: NOW_MS })
        .observedState,
      observedStateForLease(candidate, NOW_MS),
      'panel must not diverge from the shared derivation',
    );
    assert.equal(observedStateForLease(candidate, NOW_MS), expected);
  }
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

  // The Gateway reports an elapsed warm window as `unknown`; whatever it says,
  // the one thing this must never claim is that the provider stopped.
  assert.notEqual(view.observedState, 'stopped');
  assert.equal(view.observedState, 'unknown');
  assert.equal(view.cleanupFailure, 'shutdown action exited 1');
  assert.equal(view.retentionReason, 'shutdown action exited 1');
});

test('an acquired lease reports whatever the shared derivation says, not a local guess', () => {
  // The panel used to downgrade an unanswered health check to `unknown` on its
  // own. The Gateway treats an acquired lease as running unless health is
  // explicitly unhealthy, and that verdict is the only one clients may show.
  const lease_ = lease('held', 'acquired', 'run-1', { health: { state: 'unknown' } });
  const view = runtimeCapabilityRetentionView({
    entry,
    lease: lease_,
    planned: false,
    nowMs: NOW_MS,
  });

  assert.equal(view.leaseLabel, 'Acquired');
  assert.equal(view.observedState, observedStateForLease(lease_, NOW_MS));
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

test('an unavailable capability with no lease explains why it is not running', () => {
  const view = runtimeCapabilityRetentionView({
    entry: { availability: { state: 'unavailable', reason: 'no simulator matches the slot' } },
    lease: undefined,
    planned: true,
    nowMs: NOW_MS,
  });

  assert.equal(view.leaseLabel, 'Planned');
  assert.equal(view.observedState, observedStateForLease(undefined, NOW_MS));
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

test('a warm provider offers no Stop, because the release RPC would skip it', () => {
  // `runtime.capability.release` filters out already-released leases and
  // returns success, so a Stop button here would report a stop that never
  // happened while the process kept running.
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
    ['acquire'],
  );
  // The absent control is explained rather than silently missing.
  assert.match(runtimeCapabilityWarmStopUnavailable(view) ?? '', /not available yet/);
});

test('a provider that is not warm needs no warm-stop explanation', () => {
  const held = lease('held', 'acquired', 'run-1');
  const view = runtimeCapabilityRetentionView({
    entry,
    lease: held,
    planned: false,
    nowMs: NOW_MS,
  });

  assert.equal(runtimeCapabilityWarmStopUnavailable(view), null);
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
