import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  RuntimeCapabilityLease,
  RuntimeCapabilityProofRequirement,
  RuntimeCapabilityStatusResult,
} from '@farmslot/protocol';

await import('../runtime/mock-pty.test-support.js');
const { prepareDeclaredRunCapabilities, assertDeclaredCapabilityPreparation } =
  await import('./declared-capabilities.js');
const { makeRun } = await import('./test-fixtures.js');

function fixture(requirements: RuntimeCapabilityProofRequirement[] = []) {
  const run = makeRun({ id: 'run-a', slotId: 'slot-a', status: 'dispatching' });
  const status: RuntimeCapabilityStatusResult = {
    slotId: 'slot-a',
    project: 'test-project',
    catalog: [],
    leases: [],
    events: [],
    proofPlans: requirements.length
      ? {
          'run-a': {
            version: 1,
            ownerRunId: run.id,
            slotId: run.slotId!,
            createdAt: run.createdAt,
            requirements,
          },
        }
      : {},
  };
  const prepared: RuntimeCapabilityProofRequirement[][] = [];
  const deps = {
    getRun: () => run,
    status: async () => status,
    prepare: async (_runId: string, proofRequirements?: RuntimeCapabilityProofRequirement[]) => {
      prepared.push(proofRequirements!);
      return { ok: true as const };
    },
  };
  return { run, status, prepared, deps };
}

const requirement: RuntimeCapabilityProofRequirement = {
  capabilityId: 'device-client',
  mode: 'mixed',
  reason: 'Authored device proof',
  parameters: { simulator: 'device-a', port: 8081 },
};

test('declared IDs consume frozen inputs and leave unrelated authored requirements unacquired', async () => {
  const requirements = [
    requirement,
    { capabilityId: 'runtime', mode: 'state' as const, reason: 'Authored dependency' },
  ];
  const { deps, prepared } = fixture(requirements);
  assert.deepEqual(await prepareDeclaredRunCapabilities('run-a', ['device-client'], deps), {
    ok: true,
  });
  assert.deepEqual(prepared, [[requirement]]);
  assert.notEqual(prepared[0], requirements);
  prepared[0]![0]!.parameters!.simulator = 'changed-copy';
  assert.equal(requirement.parameters!.simulator, 'device-a');
});

test('missing, invalid, duplicate or foreign authored requirements refuse before acquiring', async () => {
  for (const requirements of [
    [],
    [{ ...requirement, mode: 'capture' as never }],
    [requirement, requirement],
  ]) {
    const { deps, prepared } = fixture(requirements);
    const outcome = await prepareDeclaredRunCapabilities('run-a', ['device-client'], deps);
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.match(outcome.reason, /authored proof mode/);
    assert.equal(prepared.length, 0);
  }
  const { deps, status, prepared } = fixture([requirement]);
  status.proofPlans['run-a']!.slotId = 'foreign-slot';
  const foreign = await prepareDeclaredRunCapabilities('run-a', ['device-client'], deps);
  assert.equal(foreign.ok, false);
  if (!foreign.ok) assert.match(foreign.reason, /another run or slot/);
  assert.equal(prepared.length, 0);
});

test('automatic preparation preserves a held target and refuses a changed frozen payload', async () => {
  const { run, deps, status, prepared } = fixture([requirement]);
  const lease: RuntimeCapabilityLease = {
    id: 'lease-a',
    slotId: run.slotId!,
    project: run.project,
    capabilityId: requirement.capabilityId,
    owner: { runId: run.id },
    state: 'acquired',
    referenceCount: 1,
    parameters: { port: 8081, simulator: 'device-a' },
    health: { state: 'healthy' },
    provenance: {
      project: run.project,
      providerId: requirement.capabilityId,
      version: '1',
      digest: 'provider-a',
    },
    dependencyLeaseIds: [],
    updatedAt: run.updatedAt,
  };
  status.leases.push(lease);
  assert.equal((await prepareDeclaredRunCapabilities(run.id, ['device-client'], deps)).ok, true);
  lease.parameters.simulator = 'device-b';
  const changed = await prepareDeclaredRunCapabilities(run.id, ['device-client'], deps);
  assert.equal(changed.ok, false);
  if (!changed.ok) assert.match(changed.reason, /different frozen acquire parameters/);
  assert.equal(prepared.length, 1);
  assert.equal(lease.parameters.simulator, 'device-b');
});

test('pause or generation change during preparation prevents worker delivery', async () => {
  const { run, deps, prepared } = fixture([requirement]);
  const before = await prepareDeclaredRunCapabilities(run.id, ['device-client'], {
    ...deps,
    status: async () => {
      run.engineState = { generation: 1 };
      return deps.status();
    },
  });
  assert.equal(before.ok, false);
  assert.equal(prepared.length, 0);
  const after = await prepareDeclaredRunCapabilities(run.id, ['device-client'], {
    ...deps,
    prepare: async () => {
      run.status = 'paused';
      return { ok: true };
    },
  });
  assert.equal(after.ok, false);
  assert.throws(() => assertDeclaredCapabilityPreparation(after), /superseded/);
});

test('a declaration without resources needs no invented proof mode or acquisition', async () => {
  const { deps, prepared } = fixture();
  assert.deepEqual(
    await prepareDeclaredRunCapabilities('run-a', [], {
      ...deps,
      status: async () => {
        throw new Error('No registry read needed');
      },
    }),
    { ok: true },
  );
  assert.equal(prepared.length, 0);
});
