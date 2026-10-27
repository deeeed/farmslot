import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  NativeWorkerSessionBinding,
  Run,
  RuntimeCapabilityStatusResult,
} from '@farmslot/protocol';

import {
  inspectWorkerLaunchLeftovers,
  type LaunchLeftoverDeps,
} from './worker-leftovers-preflight.js';

const run: Run = {
  id: 'fixture-run',
  familyId: 'fixture-family',
  project: 'fixture',
  flowType: 'dev',
  mode: 'interactive',
  lane: 'production',
  status: 'dispatching',
  slotId: 'fixture-slot',
  ticketOrPr: 'fixture',
  branch: null,
  taskFile: null,
  createdAt: '2026-10-27T00:00:00.000Z',
  updatedAt: '2026-10-27T00:00:00.000Z',
  steps: [],
  decisions: [],
  metrics: { nudgeCount: 0, runner: 'scripted', model: 'scripted' },
};
function fixture() {
  const status: RuntimeCapabilityStatusResult = {
    slotId: 'fixture-slot',
    project: 'fixture',
    catalog: [],
    leases: [],
    proofPlans: {},
    events: [],
  };
  let nativeReads = 0;
  const deps: LaunchLeftoverDeps = {
    cleanupInFlight: () => false,
    readSlot: async () => ({ current_run_id: run.id, phase: 'dispatching' }),
    capabilities: async () => status,
    readNative: async () => {
      nativeReads++;
      return { session: { workerLeaseId: 'old-lease', processStopped: false } };
    },
  };
  return { deps, status, reads: () => nativeReads };
}

function lease(owner: string, state: 'acquired' | 'releasing') {
  return {
    id: 'fixture-lease',
    slotId: 'fixture-slot',
    project: 'fixture',
    capabilityId: 'browser',
    owner: { runId: owner },
    state,
    referenceCount: 1,
    parameters: {},
    provenance: { project: 'fixture', providerId: 'browser', version: '1', digest: 'digest' },
    health: { state: 'healthy' as const },
    dependencyLeaseIds: [],
    updatedAt: '2026-10-27T00:00:00.000Z',
  };
}

test('observed pending cleanup refuses while current admitted leases stay protected', async () => {
  const f = fixture();
  f.status.leases.push(lease(run.id, 'acquired'));
  assert.equal((await inspectWorkerLaunchLeftovers(run, f.deps)).status, 'verified');
  f.status.leases[0].state = 'releasing';
  const result = await inspectWorkerLaunchLeftovers(run, f.deps);
  assert.equal(result.status, 'mismatch');
  assert.match(result.detail, /fixture-lease.*unreleased cleanup/);
});

test('foreign leases and current reviews are preserved without probing or stopping them', async () => {
  const f = fixture();
  f.status.leases.push(lease('another-run', 'releasing'));
  const reviewing: Run = {
    ...run,
    agentContexts: [
      {
        id: 'review',
        runId: run.id,
        slotId: run.slotId,
        role: 'review',
        label: 'Review',
        status: 'working',
      },
    ],
  };
  assert.equal((await inspectWorkerLaunchLeftovers(reviewing, f.deps)).status, 'verified');
  assert.equal(f.reads(), 0);
});

test('cancel/review-fix continuation resources are not classified by age or generation', async () => {
  const f = fixture();
  f.status.leases.push({ ...lease(run.id, 'acquired'), acquiredAt: '2026-01-01T00:00:00.000Z' });
  const retained: Run = { ...run, status: 'paused', engineState: { generation: 27 } };
  assert.equal((await inspectWorkerLaunchLeftovers(retained, f.deps)).status, 'verified');
});

test('a released historical native lease still holding its process refuses; transfer remains foreign', async () => {
  const f = fixture();
  const binding: NativeWorkerSessionBinding = {
    sessionId: 'saved-session',
    leaseId: 'old-lease',
    commandId: 'command',
    ownerPrincipalId: 'owner',
    executionNodeId: 'local',
    releasedAt: '2026-10-26T00:00:00.000Z',
  };
  const prior: Run = {
    ...run,
    agentContexts: [
      {
        id: 'worker',
        runId: run.id,
        slotId: run.slotId,
        role: 'dev',
        label: 'Worker',
        status: 'working',
        nativeSessionHistory: [binding],
      },
    ],
  };
  assert.equal((await inspectWorkerLaunchLeftovers(prior, f.deps)).status, 'mismatch');
  f.deps.readNative = async () => ({
    session: { workerLeaseId: 'new-owner-lease', processStopped: false },
  });
  assert.equal((await inspectWorkerLaunchLeftovers(prior, f.deps)).status, 'verified');
  f.deps.readNative = async () => ({ session: {} });
  assert.equal((await inspectWorkerLaunchLeftovers(prior, f.deps)).status, 'unverified');
});

test('in-flight canonical teardown refuses without starting competing cleanup', async () => {
  const f = fixture();
  f.deps.cleanupInFlight = () => true;
  const result = await inspectWorkerLaunchLeftovers(run, f.deps);
  assert.equal(result.status, 'mismatch');
  assert.match(result.detail, /cleanup is still in flight/);
  assert.equal(f.reads(), 0);
});
