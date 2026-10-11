import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  RuntimeCapabilityAcquireParams,
  RuntimeCapabilityLease,
  RuntimeCapabilityReleaseParams,
} from '@farmslot/protocol';

import { createRuntimeCapabilityRecordingAdmission } from '../src/recording-admission.js';

const owner: RuntimeCapabilityAcquireParams = {
  slotId: 'slot-a',
  ownerRunId: 'run-a',
  capabilityId: 'recorder',
  proofRequirement: { capabilityId: 'recorder', reason: 'UI proof', mode: 'visual' },
  parameters: { quality: 'default' },
};
const context = {
  backend: 'capture',
  target: { kind: 'pid' as const, pid: 42 },
  projectRoot: '/project',
  artifactsDir: '/artifacts',
};
const lease: RuntimeCapabilityLease = {
  id: 'lease-a',
  slotId: owner.slotId,
  project: 'example',
  capabilityId: owner.capabilityId,
  owner: { runId: owner.ownerRunId },
  state: 'acquired',
  referenceCount: 1,
  parameters: {},
  provenance: { project: 'example', providerId: 'recorder', version: '1', digest: 'digest' },
  health: { state: 'healthy' },
  dependencyLeaseIds: [],
  updatedAt: '2026-01-01T00:00:00Z',
};

for (const idempotent of [false, true]) {
  test(`recording admission preserves ${idempotent ? 'pre-held' : 'owned'} lease ownership`, async () => {
    const acquired: RuntimeCapabilityAcquireParams[] = [];
    const released: RuntimeCapabilityReleaseParams[] = [];
    const admission = createRuntimeCapabilityRecordingAdmission(
      {
        async acquire(params) {
          acquired.push(params);
          return { ok: true, lease, dependencyLeases: [], idempotent };
        },
        async release(params) {
          released.push(params);
          return { ok: true, released: [lease], retained: [], effects: [], failures: [] };
        },
      },
      owner,
    );
    const held = await admission.acquire(context);
    assert.deepEqual(acquired, [
      {
        ...owner,
        parameters: {
          quality: 'default',
          recording: { backend: context.backend, target: context.target },
        },
      },
    ]);
    await held.release();
    assert.deepEqual(
      released,
      idempotent
        ? []
        : [
            {
              slotId: owner.slotId,
              ownerRunId: owner.ownerRunId,
              leaseId: lease.id,
              keepWarm: false,
            },
          ],
    );
    assert.deepEqual(owner.parameters, { quality: 'default' });
  });
}

test('admission refusal does not release the conflicting holder', async () => {
  let releases = 0;
  const admission = createRuntimeCapabilityRecordingAdmission(
    {
      async acquire() {
        return {
          ok: false,
          conflict: {
            kind: 'lease-conflict',
            capabilityId: 'recorder',
            owner: { runId: 'foreign' },
            leaseId: 'foreign-lease',
            reason: 'Target is occupied.',
          },
        };
      },
      async release() {
        releases++;
        return { ok: true, released: [], retained: [], effects: [], failures: [] };
      },
    },
    owner,
  );
  await assert.rejects(admission.acquire(context), /Target is occupied/);
  assert.equal(releases, 0);
});

test('owned cleanup failures remain visible to the engine', async () => {
  const admission = createRuntimeCapabilityRecordingAdmission(
    {
      async acquire() {
        return { ok: true, lease, dependencyLeases: [], idempotent: false };
      },
      async release() {
        return {
          ok: false,
          released: [],
          retained: [lease],
          effects: [],
          failures: [
            {
              leaseId: lease.id,
              capabilityId: lease.capabilityId,
              reason: 'Recorder is still alive.',
            },
          ],
        };
      },
    },
    owner,
  );
  const held = await admission.acquire(context);
  await assert.rejects(held.release(), /Recorder is still alive/);
});
