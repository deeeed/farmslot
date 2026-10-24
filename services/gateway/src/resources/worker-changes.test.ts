import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { NodeTmuxPane, ResourceChangedPayload } from '@farmslot/protocol';

import { createGatewayAuthRuntime, initializeGatewayIdentity } from '../security/auth.js';
import type { ClientState } from '../server/client-state.js';

import { canReadResourceKey } from './authorization.js';
import { GatewayResourceRevisions } from './revisions.js';
import { captureRunResources, publishRunResources } from './run-changes.js';
import { SlotResourceChanges, statusSlotResources } from './slot-run-bindings.js';
import {
  nextWorkerStatusExpiry,
  publishWorkerResources,
  scheduleWorkerStatusExpiry,
} from './worker-changes.js';

const collection = { family: 'workers', scope: 'farm' } as const;
const node = { family: 'workers', nodeId: 'node' } as const;

test('worker source bursts coalesce both inventory scopes after source commit', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const revisions = new GatewayResourceRevisions();
  const packets: ResourceChangedPayload[] = [];
  revisions.setPublisher((packet) => packets.push(packet));
  try {
    for (let i = 0; i < 30; i++) publishWorkerResources('node', revisions);
    t.mock.timers.tick(199);
    assert.equal(packets.length, 0);
    t.mock.timers.tick(1);
    assert.equal(packets.length, 1);
    assert.deepEqual(packets[0].changes, [
      { key: collection, revision: 30, kind: 'updated' },
      { key: node, revision: 30, kind: 'updated' },
    ]);
  } finally {
    revisions.dispose();
  }
});

test('worker status expiry advances once, can be superseded and stops after source teardown', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100_000 });
  const revisions = new GatewayResourceRevisions();
  const pane: NodeTmuxPane = {
    session: 'scratch',
    window: '0',
    pane: '0',
    target: '%1',
    lastChangedAt: 99_000,
    signals: { hook: { observedAt: 90_000, event: 'working' } },
  };
  try {
    assert.equal(nextWorkerStatusExpiry([pane]), 129_001);
    scheduleWorkerStatusExpiry('node', [pane], revisions);
    t.mock.timers.tick(29_000);
    assert.equal(revisions.revision(node), 0);
    t.mock.timers.tick(1);
    assert.equal(revisions.revision(node), 1);
    scheduleWorkerStatusExpiry('node', [pane], revisions);
    t.mock.timers.tick(80_999);
    assert.equal(revisions.revision(node), 1);
    t.mock.timers.tick(1);
    assert.equal(revisions.revision(node), 2);
    assert.equal(nextWorkerStatusExpiry([pane]), undefined);
    scheduleWorkerStatusExpiry('node', [{ ...pane, lastChangedAt: Date.now() }], revisions);
    scheduleWorkerStatusExpiry('node', [], revisions);
    t.mock.timers.tick(1_000_000);
    assert.equal(revisions.revision(node), 2, 'A cleared source never restarts an inventory timer');
  } finally {
    revisions.dispose();
  }
});

test('run and relevant slot writers invalidate inventory while checked_at alone stays quiet', () => {
  const revisions = new GatewayResourceRevisions();
  const changes = new SlotResourceChanges(revisions);
  const rows = { slots: [{ slot: 'slot', current_run_id: 'run', lifecycle: 'busy' }] };
  try {
    changes.observe(statusSlotResources(rows), '2026-10-23T00:00:00Z');
    const first = revisions.revision(collection);
    changes.observe(statusSlotResources(rows), '2026-10-23T00:00:01Z');
    assert.equal(revisions.revision(collection), first);
    changes.observe(statusSlotResources({ slots: [{ ...rows.slots[0], lifecycle: 'held' }] }));
    assert.equal(revisions.revision(collection), first + 1);
    const run = captureRunResources({ id: 'run', familyId: 'family', decisions: [] });
    publishRunResources(run, run, 'updated', revisions);
    assert.equal(revisions.revision(collection), first + 2);
    changes.unavailable();
    const failed = revisions.revision(collection);
    changes.unavailable();
    assert.equal(revisions.revision(collection), failed);
  } finally {
    revisions.dispose();
  }
});

test('worker notifications follow inventory read authority and disappear after role revocation', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'workers-resource-auth-'));
  try {
    const runtime = createGatewayAuthRuntime({ FARMSLOT_HOME: home });
    initializeGatewayIdentity(runtime, { host: '127.0.0.1' });
    const principal = runtime.writer.createPrincipal(
      { type: 'person', displayName: 'Worker observer' },
      [],
    );
    const credential = runtime.writer.issueCredential(principal.id, 'worker-observer');
    const grant = runtime.writer.exchangePersonCredential(credential.secret, {
      deviceName: 'Worker observer',
      deviceKind: 'cli',
    });
    const resolution = runtime.resolver.resolveSecret(grant.accessToken, 'token');
    assert(resolution.ok && resolution.authentication);
    const state = {
      authenticated: true,
      clientKind: 'ui',
      authentication: resolution.authentication,
    } as ClientState;
    assert.equal(canReadResourceKey(runtime, state, collection), false);
    assert.equal(canReadResourceKey(runtime, state, node), false);
    runtime.writer.grantRole(principal.id, 'admin', { kind: 'global' });
    assert.equal(canReadResourceKey(runtime, state, collection), true);
    assert.equal(canReadResourceKey(runtime, state, node), true);
    runtime.writer.revokeRole(principal.id, 'admin', { kind: 'global' });
    assert.equal(canReadResourceKey(runtime, state, node), false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
