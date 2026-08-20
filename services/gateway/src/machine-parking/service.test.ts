import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  MachineParkRecord,
  MachinePauseRecoveryHandle,
  Run,
  RuntimeCapabilityStatusResult,
  SlotResource,
} from '@farmslot/protocol';

import { makeRun } from '../run-engine/test-fixtures.js';
import { withMachineRunTransition } from '../run-lifecycle/transition-coordinator.js';

import type { MachineParkingIntentJournal } from './journal.js';
import { type MachineParkingDependencies, MachineParkingService } from './service.js';

function recoveryHandle(runId: string, slotId: string): MachinePauseRecoveryHandle {
  return {
    version: 1,
    runnerId: 'claude',
    contextId: 'primary',
    sessionId: `session-${runId}`,
    sessionPath: `/sessions/${runId}.jsonl`,
    target: {
      session: slotId,
      window: 'worker',
      paneId: `%${runId.replace(/\D/g, '') || '1'}`,
      target: `${slotId}:worker`,
    },
    model: 'sonnet',
    capturedAt: '2026-08-21T00:00:00.000Z',
  };
}

function runningResource(id = 'browser-cdp'): SlotResource {
  return {
    id,
    definition: {
      type: 'browser',
      label: id,
      streamable: true,
      controllable: true,
      hooks: { health: 'health', shutdown: 'stop', boot: 'start' },
    },
    status: 'running',
  };
}

function capabilityStatusFor(
  runId: string,
  options: { foreignRunId?: string; leaseState?: 'acquired' | 'released' } = {},
): RuntimeCapabilityStatusResult {
  const lease = (ownerRunId: string, id: string) => ({
    id,
    slotId: 'slot-a',
    project: 'test',
    capabilityId: 'browser-cdp',
    owner: { runId: ownerRunId },
    state: options.leaseState ?? ('acquired' as const),
    referenceCount: 1,
    parameters: {},
    provenance: { project: 'test', providerId: 'browser-cdp', version: '1', digest: 'x' },
    health: { state: 'healthy' as const },
    dependencyLeaseIds: [],
    updatedAt: '2026-08-21T00:00:00.000Z',
  });
  return {
    slotId: 'slot-a',
    project: 'test',
    catalog: [
      {
        id: 'browser-cdp',
        project: 'test',
        label: 'Browser',
        description: 'Browser',
        version: '1',
        sharePolicy: 'exclusive',
        actions: {
          acquire: { kind: 'resource', resourceId: 'browser-cdp', action: 'boot' },
          health: { kind: 'resource', resourceId: 'browser-cdp', action: 'health' },
          release: { kind: 'resource', resourceId: 'browser-cdp', action: 'shutdown' },
        },
        cost: { class: 'high', resources: [] },
        releaseEffects: [],
        provenance: { project: 'test', providerId: 'browser-cdp', version: '1', digest: 'x' },
        availability: { state: 'available' },
      },
    ],
    leases: [
      lease(runId, 'lease-browser'),
      ...(options.foreignRunId ? [lease(options.foreignRunId, 'lease-foreign')] : []),
    ],
    proofPlans: {
      [runId]: {
        version: 1,
        slotId: 'slot-a',
        ownerRunId: runId,
        createdAt: '2026-08-21T00:00:00.000Z',
        requirements: [{ capabilityId: 'browser-cdp', reason: 'visual proof', mode: 'visual' }],
      },
    },
    events: [],
  };
}

function activeRun(
  id: string,
  slotId: string,
  status: 'monitoring' | 'ci-watching' = 'monitoring',
) {
  return makeRun({
    id,
    familyId: `family-${id}`,
    status,
    slotId,
    steps: [{ name: status === 'monitoring' ? 'monitor' : 'ci-watch', status: 'running' }],
    metrics: {
      nudgeCount: 0,
      model: 'sonnet',
      runner: 'claude',
      runnerSessionId: `session-${id}`,
      runnerSessionPath: `/sessions/${id}.jsonl`,
    },
    engineState: { generation: 3 },
  });
}

function parkedRecord(runId: string, slotId: string): MachineParkRecord {
  return {
    version: 1,
    operationId: `park-${runId}`,
    previewId: `preview-${runId}`,
    runId,
    generation: 3,
    machine: 'machine-a',
    slotId,
    mode: 'orchestration',
    phase: 'parked',
    prePauseStatus: 'monitoring',
    prePauseCurrentStep: { index: 0, name: 'monitor', status: 'running' },
    resourceManifest: {
      capturedAt: '2026-08-21T00:00:00.000Z',
      resources: [],
      capabilityLeases: [],
    },
    recoveryHandle: null,
    errors: [],
    residuals: { runner: 'running', resources: [] },
    createdAt: '2026-08-21T00:00:00.000Z',
    updatedAt: '2026-08-21T00:00:00.000Z',
  };
}

interface Harness {
  service: MachineParkingService;
  runs: Map<string, Run>;
  calls: string[];
  deps: MachineParkingDependencies;
}

function harness(initialRuns: Run[]): Harness {
  const runs = new Map(initialRuns.map((run) => [run.id, structuredClone(run)]));
  const runnerStates = new Map<string, 'running' | 'stopped' | 'unknown'>(
    initialRuns.map((run) => [run.id, 'running']),
  );
  const calls: string[] = [];
  const journals = new Map<string, MachineParkingIntentJournal>();
  let tick = 0;
  const status: RuntimeCapabilityStatusResult = {
    slotId: 'unused',
    project: 'test',
    catalog: [],
    leases: [],
    proofPlans: {},
    events: [],
  };
  const deps: MachineParkingDependencies = {
    now: () => `2026-08-21T00:00:${String(tick++).padStart(2, '0')}.000Z`,
    operationId: () => `operation-${tick}`,
    allRuns: () => [...runs.values()],
    getRun: (runId) => runs.get(runId),
    loadFleet: async () =>
      ({
        checkedAt: '2026-08-21T00:00:00.000Z',
        machines: [{ machine: 'machine-a', online: true }],
        slots: [...runs.values()]
          .filter((run) => run.slotId)
          .map((run) => ({
            slot: run.slotId!,
            machine: 'machine-a',
            project: run.project,
            lifecycle: 'busy',
            phase: 'working',
            enabled: true,
            currentRunId: run.id,
          })),
      }) as never,
    updatePark: (runId, park) => {
      const run = runs.get(runId)!;
      run.park = park ? structuredClone(park) : null;
      return run;
    },
    persistRun: async (run, reason) => {
      calls.push(`persist:${run.id}:${reason}`);
    },
    writeIntentJournal: async (kind, records) => {
      calls.push(`journal-write:${records[0]!.operationId}`);
      const first = records[0]!;
      journals.set(`${first.machine}:${kind}:${first.operationId}`, {
        version: 1,
        kind,
        machine: first.machine,
        operationId: first.operationId,
        records: structuredClone(records),
      });
    },
    deleteIntentJournal: async (machine, kind, operationId) => {
      calls.push(`journal-delete:${operationId}`);
      journals.delete(`${machine}:${kind}:${operationId}`);
    },
    loadIntentJournals: async () =>
      [...journals.values()].map((journal) => structuredClone(journal)),
    emit: async (event) => {
      calls.push(`emit:${event}`);
    },
    pressure: async () => undefined,
    observeResources: async (slotId) => {
      calls.push(`observe:${slotId}`);
      const run = [...runs.values()].find((candidate) => candidate.slotId === slotId);
      const phase = run?.park?.resourceManifest.resources[0]?.phase;
      return phase === 'stopped'
        ? [{ ...runningResource(), status: 'stopped' }]
        : [runningResource()];
    },
    capabilityStatus: async () => structuredClone(status),
    releaseCapability: async () => ({
      ok: true,
      released: [],
      retained: [],
      effects: [],
      failures: [],
    }),
    acquireCapability: async (params) => {
      calls.push(`acquire-capability:${params.ownerRunId}:${params.capabilityId}`);
      return {
        ok: true,
        idempotent: false,
        dependencyLeases: [],
        lease: {
          id: `restored-${params.capabilityId}`,
          slotId: params.slotId,
          project: 'test',
          capabilityId: params.capabilityId,
          owner: { runId: params.ownerRunId },
          state: 'acquired',
          referenceCount: 1,
          parameters: params.parameters ?? {},
          provenance: {
            project: 'test',
            providerId: params.capabilityId,
            version: '1',
            digest: 'x',
          },
          health: { state: 'healthy' },
          dependencyLeaseIds: [],
          updatedAt: '2026-08-21T00:00:00.000Z',
        },
      };
    },
    resolveRecoveryHandle: async (run) => recoveryHandle(run.id, run.slotId!),
    inspectRecoveryHandle: async () => {},
    pauseRun: async (runId, emit) => {
      calls.push(`pause:${runId}`);
      runs.get(runId)!.status = 'paused';
      emit('run.updated', { runId });
    },
    resumeRun: async (runId, emit) => {
      calls.push(`resume:${runId}`);
      const run = runs.get(runId)!;
      const previousGeneration = run.engineState?.generation ?? 0;
      run.status = run.park!.prePauseStatus;
      run.engineState = {
        ...run.engineState,
        generation: (run.engineState?.generation ?? 0) + 1,
      };
      emit('run.updated', { runId });
      return {
        run,
        previousGeneration,
        generation: run.engineState.generation!,
        stepName: run.park!.prePauseCurrentStep!.name,
        status: run.status as 'monitoring' | 'ci-watching',
        acknowledgedAt: '2026-08-21T00:00:31.000Z',
      };
    },
    stopRunner: async (run) => {
      calls.push(`stop-runner:${run.id}`);
      runnerStates.set(run.id, 'stopped');
    },
    reloadRunner: async (run, _handle, prompt) => {
      calls.push(`reload-runner:${run.id}`);
      calls.push(`reload-prompt:${prompt}`);
      runnerStates.set(run.id, 'running');
      return {
        sessionId: `session-${run.id}`,
        live: true,
        acknowledgement: {
          kind: 'structured',
          source: 'test-hook',
          reason: 'prompt digest accepted',
          turnToken: `turn-${run.id}`,
        },
        acceptedAt: '2026-08-21T00:00:30.000Z',
      };
    },
    runnerRunning: async (run) => runnerStates.get(run.id) ?? 'unknown',
    stopResource: async (slotId, resourceId) => {
      calls.push(`stop-resource:${slotId}:${resourceId}`);
      return { ok: true };
    },
    startResource: async (slotId, resourceId) => {
      calls.push(`start-resource:${slotId}:${resourceId}`);
      return { ok: true };
    },
  };
  return { service: new MachineParkingService(deps), runs, calls, deps };
}

function mixedRestoreHarness(): Harness {
  const zero = activeRun('run-zero', 'slot-zero');
  zero.park = {
    ...parkedRecord(zero.id, 'slot-zero'),
    phase: 'partial',
    errors: [
      {
        phase: 'orchestration-pausing',
        action: 'run.pause',
        code: 'EFFECT_FAILED',
        message: 'pause failed before mutation',
        occurredAt: '2026-08-21T00:00:01.000Z',
        retryable: true,
      },
    ],
  };
  const effect = activeRun('run-effect', 'slot-effect');
  effect.status = 'paused';
  effect.park = {
    ...parkedRecord(effect.id, 'slot-effect'),
    mode: 'release',
    recoveryHandle: recoveryHandle(effect.id, 'slot-effect'),
    residuals: { runner: 'stopped', resources: [] },
  };
  const ctx = harness([zero, effect]);
  ctx.deps.runnerRunning = async (run) => (run.id === effect.id ? 'stopped' : 'running');
  return ctx;
}

test('preview returns backend-selected and backend-owned eligibility for every machine run', async () => {
  const good = activeRun('run-good', 'slot-good');
  const rejected = makeRun({
    ...activeRun('run-rejected', 'slot-rejected'),
    status: 'blocked',
  });
  const ctx = harness([good, rejected]);
  const preview = await ctx.service.preview({
    machine: 'machine-a',
    mode: 'orchestration',
    selector: { kind: 'include', runIds: ['run-good'] },
  });

  assert.equal(preview.runs.length, 2);
  assert.deepEqual(
    preview.runs.map((run) => [run.runId, run.selected, run.eligibility.code]),
    [
      ['run-good', true, 'ELIGIBLE_ORCHESTRATION_PAUSE'],
      ['run-rejected', false, 'STATUS_NOT_ELIGIBLE'],
    ],
  );
  assert.equal(preview.eligibleCount, 1);
  assert.equal(preview.rejectedCount, 0);
});

test('raw RPC modes and unknown status machines fail before state access or effects', async () => {
  const ctx = harness([activeRun('run-a', 'slot-a')]);
  await assert.rejects(
    () =>
      ctx.service.preview({
        machine: 'machine-a',
        mode: 'invalid' as never,
        selector: { kind: 'all' },
      }),
    /mode must be exactly/,
  );
  await assert.rejects(
    () =>
      ctx.service.execute({
        machine: 'machine-a',
        mode: 'invalid' as never,
        previewId: 'raw-preview',
        reviewedTargets: [],
      }),
    /mode must be exactly/,
  );
  await assert.rejects(() => ctx.service.status('machine-missing'), /Machine not found/);
  assert.equal(
    ctx.calls.some((call) => call.startsWith('pause:')),
    false,
  );
});

test('status keeps durable records queryable after their machine leaves the fleet', async () => {
  const run = activeRun('run-a', 'slot-a');
  run.park = {
    ...parkedRecord(run.id, 'slot-a'),
    machine: 'removed-machine',
  };
  const ctx = harness([run]);
  const status = await ctx.service.status('removed-machine');
  assert.equal(status.records.length, 1);
  assert.equal(status.records[0]?.runId, 'run-a');
  await assert.rejects(() => ctx.service.status('typo-machine'), /Machine not found/);
});

test('release preview rejects a capability-backed resource with a foreign holder', async () => {
  const ctx = harness([activeRun('run-a', 'slot-a')]);
  ctx.deps.capabilityStatus = async () =>
    capabilityStatusFor('run-a', { foreignRunId: 'run-foreign' });
  const preview = await ctx.service.preview({
    machine: 'machine-a',
    mode: 'release',
    selector: { kind: 'all' },
  });
  assert.deepEqual(preview.runs[0]?.eligibility, {
    eligible: false,
    code: 'CAPABILITY_FOREIGN_HOLDER',
    reason: "resource 'browser-cdp' is held by run-foreign/browser-cdp",
  });
  await assert.rejects(
    () =>
      ctx.service.execute({
        machine: 'machine-a',
        mode: 'release',
        previewId: preview.previewId,
        reviewedTargets: [{ runId: 'run-a', generation: 3 }],
      }),
    /batch rejected before mutation/,
  );
  assert.equal(
    ctx.calls.some((call) => call.startsWith('stop-resource:')),
    false,
  );
});

test('release preview rejects capability-backed resources not leased by the selected run', async () => {
  const ctx = harness([activeRun('run-a', 'slot-a')]);
  const status = capabilityStatusFor('run-a');
  status.leases = [];
  ctx.deps.capabilityStatus = async () => structuredClone(status);
  const preview = await ctx.service.preview({
    machine: 'machine-a',
    mode: 'release',
    selector: { kind: 'all' },
  });
  assert.equal(preview.runs[0]?.eligibility.code, 'CAPABILITY_RESOURCE_UNOWNED');
});

test('active unmapped slot-action capability fails closed during preview', async () => {
  const ctx = harness([activeRun('run-a', 'slot-a')]);
  const status = capabilityStatusFor('run-a');
  status.catalog[0]!.actions = {
    acquire: { kind: 'slot-action', actionId: 'browser-start' },
    health: { kind: 'slot-action', actionId: 'browser-health' },
    release: { kind: 'slot-action', actionId: 'browser-stop' },
  };
  ctx.deps.capabilityStatus = async () => structuredClone(status);
  const preview = await ctx.service.preview({
    machine: 'machine-a',
    mode: 'release',
    selector: { kind: 'all' },
  });
  assert.equal(preview.runs[0]?.eligibility.code, 'CAPABILITY_SLOT_ACTION_UNMAPPED');
});

test('foreign active unmapped slot-action capability also fails closed', async () => {
  const ctx = harness([activeRun('run-a', 'slot-a')]);
  const status = capabilityStatusFor('run-foreign');
  status.catalog[0]!.actions = {
    acquire: { kind: 'slot-action', actionId: 'browser-start' },
    health: { kind: 'slot-action', actionId: 'browser-health' },
    release: { kind: 'slot-action', actionId: 'browser-stop' },
  };
  ctx.deps.capabilityStatus = async () => structuredClone(status);
  const preview = await ctx.service.preview({
    machine: 'machine-a',
    mode: 'release',
    selector: { kind: 'all' },
  });
  assert.equal(preview.runs[0]?.eligibility.code, 'CAPABILITY_SLOT_ACTION_UNMAPPED');
});

test('mixed resource acquire and slot-action release fails closed for selected capability', async () => {
  const ctx = harness([activeRun('run-a', 'slot-a')]);
  const status = capabilityStatusFor('run-a');
  status.catalog[0]!.actions.release = { kind: 'slot-action', actionId: 'browser-stop' };
  ctx.deps.capabilityStatus = async () => structuredClone(status);
  const preview = await ctx.service.preview({
    machine: 'machine-a',
    mode: 'release',
    selector: { kind: 'all' },
  });
  assert.equal(preview.runs[0]?.eligibility.code, 'CAPABILITY_SLOT_ACTION_UNMAPPED');
});

test('registry-retained capability never falls through to direct resource shutdown', async () => {
  const ctx = harness([activeRun('run-a', 'slot-a')]);
  ctx.deps.capabilityStatus = async () => capabilityStatusFor('run-a');
  ctx.deps.releaseCapability = async () => ({
    ok: true,
    released: [],
    retained: capabilityStatusFor('run-a').leases,
    effects: [],
    failures: [],
  });
  const preview = await ctx.service.preview({
    machine: 'machine-a',
    mode: 'release',
    selector: { kind: 'all' },
  });
  const result = await ctx.service.execute({
    machine: 'machine-a',
    mode: 'release',
    previewId: preview.previewId,
    reviewedTargets: [{ runId: 'run-a', generation: 3 }],
    operationId: 'retained-provider',
  });
  assert.equal(result.ok, false);
  assert.equal(
    ctx.calls.some((call) => call.startsWith('stop-resource:')),
    false,
  );
  assert.equal(
    ctx.runs
      .get('run-a')
      ?.park?.errors.some((error) => error.action === 'capability.release-retained'),
    true,
  );
});

test('foreign lease acquired after intent still cannot trigger direct capability resource shutdown', async () => {
  const ctx = harness([activeRun('run-a', 'slot-a')]);
  let status = capabilityStatusFor('run-a');
  ctx.deps.capabilityStatus = async () => structuredClone(status);
  ctx.deps.releaseCapability = async () => {
    const own = capabilityStatusFor('run-a', { leaseState: 'released' }).leases[0]!;
    const foreign = capabilityStatusFor('run-foreign').leases[0]!;
    status = { ...status, leases: [own, { ...foreign, id: 'lease-foreign' }] };
    return { ok: true, released: [own], retained: [], effects: [], failures: [] };
  };
  const preview = await ctx.service.preview({
    machine: 'machine-a',
    mode: 'release',
    selector: { kind: 'all' },
  });
  const result = await ctx.service.execute({
    machine: 'machine-a',
    mode: 'release',
    previewId: preview.previewId,
    reviewedTargets: [{ runId: 'run-a', generation: 3 }],
    operationId: 'foreign-after-intent',
  });
  assert.equal(result.ok, false);
  assert.equal(
    ctx.calls.some((call) => call.startsWith('stop-resource:')),
    false,
  );
});

test('empty include renders every pause and restore row unselected while execute fails closed', async () => {
  const ctx = harness([activeRun('run-a', 'slot-a')]);
  const emptyPause = await ctx.service.preview({
    machine: 'machine-a',
    mode: 'orchestration',
    selector: { kind: 'include', runIds: [] },
  });
  assert.equal(emptyPause.runs.length, 1);
  assert.equal(emptyPause.runs[0]?.selected, false);
  assert.equal(emptyPause.eligibleCount, 0);
  await assert.rejects(
    () =>
      ctx.service.execute({
        machine: 'machine-a',
        mode: 'orchestration',
        previewId: emptyPause.previewId,
        reviewedTargets: [],
        operationId: 'empty-pause',
      }),
    /selection resolved to no runs/,
  );

  const pause = await ctx.service.preview({
    machine: 'machine-a',
    mode: 'orchestration',
    selector: { kind: 'all' },
  });
  await ctx.service.execute({
    machine: 'machine-a',
    mode: 'orchestration',
    previewId: pause.previewId,
    reviewedTargets: [{ runId: 'run-a', generation: 3 }],
    operationId: 'park-for-empty-restore',
  });
  const emptyRestore = await ctx.service.restore({
    machine: 'machine-a',
    selector: { kind: 'include', runIds: [] },
  });
  assert.equal(emptyRestore.runs.length, 1);
  assert.equal(emptyRestore.runs[0]?.selected, false);
  await assert.rejects(
    () =>
      ctx.service.restore({
        machine: 'machine-a',
        selector: { kind: 'include', runIds: [] },
        execute: true,
        previewId: emptyRestore.previewId,
        reviewedTargets: [],
        operationId: 'empty-restore',
      }),
    /selection resolved to no runs/,
  );
});

test('exclude selection mutates only its exact complement and cannot widen reviewed targets', async () => {
  const ctx = harness([activeRun('run-a', 'slot-a'), activeRun('run-b', 'slot-b')]);
  const preview = await ctx.service.preview({
    machine: 'machine-a',
    mode: 'orchestration',
    selector: { kind: 'exclude', runIds: ['run-b'] },
  });
  assert.deepEqual(
    preview.runs.map((run) => [run.runId, run.selected]),
    [
      ['run-a', true],
      ['run-b', false],
    ],
  );
  await assert.rejects(
    () =>
      ctx.service.execute({
        machine: 'machine-a',
        mode: 'orchestration',
        previewId: preview.previewId,
        reviewedTargets: [
          { runId: 'run-a', generation: 3 },
          { runId: 'run-b', generation: 3 },
        ],
        operationId: 'exclude-widened',
      }),
    /refusing widening/,
  );
  assert.equal(ctx.runs.get('run-a')?.park, undefined);
  assert.equal(ctx.runs.get('run-b')?.park, undefined);

  const result = await ctx.service.execute({
    machine: 'machine-a',
    mode: 'orchestration',
    previewId: preview.previewId,
    reviewedTargets: [{ runId: 'run-a', generation: 3 }],
    operationId: 'exclude-exact',
  });
  assert.equal(result.ok, true);
  assert.equal(ctx.runs.get('run-a')?.park?.phase, 'parked');
  assert.equal(ctx.runs.get('run-b')?.park, undefined);
  assert.equal(ctx.calls.includes('pause:run-a'), true);
  assert.equal(ctx.calls.includes('pause:run-b'), false);
});

test('missing session path rejects the whole final preflight before writing any park record', async () => {
  const ctx = harness([activeRun('run-a', 'slot-a'), activeRun('run-b', 'slot-b')]);
  const preview = await ctx.service.preview({
    machine: 'machine-a',
    mode: 'release',
    selector: { kind: 'all' },
  });
  ctx.deps.inspectRecoveryHandle = async (run) => {
    if (run.id === 'run-b') throw new Error('Persisted runner session path is unavailable');
  };

  await assert.rejects(
    () =>
      ctx.service.execute({
        machine: 'machine-a',
        mode: 'release',
        previewId: preview.previewId,
        reviewedTargets: preview.runs.map(({ runId, generation }) => ({ runId, generation })),
        operationId: 'atomic-preflight',
      }),
    /session path is unavailable/,
  );
  assert.equal(ctx.runs.get('run-a')!.park, undefined);
  assert.equal(ctx.runs.get('run-b')!.park, undefined);
  assert.equal(
    ctx.calls.some((call) => call.startsWith('pause:')),
    false,
  );
});

test('intent persistence failure returns complete typed failures, applies zero effects, and repairs on restart', async () => {
  const ctx = harness([activeRun('run-a', 'slot-a'), activeRun('run-b', 'slot-b')]);
  const persist = ctx.deps.persistRun;
  ctx.deps.persistRun = async (run, reason) => {
    if (run.id === 'run-b' && reason === 'machine-pause-intent') {
      throw new Error('disk write failed');
    }
    await persist(run, reason);
  };
  const preview = await ctx.service.preview({
    machine: 'machine-a',
    mode: 'orchestration',
    selector: { kind: 'all' },
  });
  const params = {
    machine: 'machine-a',
    mode: 'orchestration' as const,
    previewId: preview.previewId,
    reviewedTargets: preview.runs.map(({ runId, generation }) => ({ runId, generation })),
    operationId: 'persist-failure',
  };
  const result = await ctx.service.execute(params);
  assert.equal(result.ok, false);
  assert.equal(result.records.length, 2);
  assert.equal(
    result.records.every((record) => record.phase === 'failed'),
    true,
  );
  assert.equal(
    result.records.every((record) =>
      record.errors.some((error) => error.code === 'INTENT_BATCH_NOT_DURABLE'),
    ),
    true,
  );
  assert.equal(
    ctx.calls.some((call) => call.startsWith('pause:')),
    false,
  );

  const retry = await ctx.service.execute(params);
  assert.equal(
    retry.records.every((record) => record.phase === 'failed'),
    true,
  );
  assert.equal(
    ctx.calls.some((call) => call.startsWith('pause:')),
    false,
  );

  await ctx.service.reconcile();
  assert.equal(ctx.runs.get('run-a')?.park, null);
  assert.equal(ctx.runs.get('run-b')?.park, null);
});

test('pause throw leaves durable partial evidence that restart clears as zero-effect', async () => {
  const ctx = harness([activeRun('run-a', 'slot-a')]);
  ctx.deps.pauseRun = async () => {
    throw new Error('pause transition failed before status mutation');
  };
  const preview = await ctx.service.preview({
    machine: 'machine-a',
    mode: 'orchestration',
    selector: { kind: 'all' },
  });
  const result = await ctx.service.execute({
    machine: 'machine-a',
    mode: 'orchestration',
    previewId: preview.previewId,
    reviewedTargets: [{ runId: 'run-a', generation: 3 }],
    operationId: 'pause-throw',
  });
  assert.equal(result.ok, false);
  assert.equal(ctx.runs.get('run-a')?.status, 'monitoring');
  assert.equal(ctx.runs.get('run-a')?.park?.phase, 'partial');
  await ctx.service.reconcile();
  assert.equal(ctx.runs.get('run-a')?.park, null);
});

test('restore settles zero-effect failure without lifecycle or resource effects and allows re-pause', async () => {
  const ctx = harness([activeRun('run-a', 'slot-a')]);
  ctx.deps.pauseRun = async () => {
    throw new Error('pause failed before mutation');
  };
  const pausePreview = await ctx.service.preview({
    machine: 'machine-a',
    mode: 'orchestration',
    selector: { kind: 'all' },
  });
  await ctx.service.execute({
    machine: 'machine-a',
    mode: 'orchestration',
    previewId: pausePreview.previewId,
    reviewedTargets: [{ runId: 'run-a', generation: 3 }],
    operationId: 'zero-effect-pause',
  });
  const restorePreview = await ctx.service.restore({
    machine: 'machine-a',
    selector: { kind: 'all' },
  });
  assert.equal(restorePreview.runs[0]?.eligibility.code, 'ELIGIBLE_ZERO_EFFECT_REPAIR');
  const beforeEffects = ctx.calls.filter((call) =>
    /^(pause|resume|start-resource|stop-resource):/.test(call),
  ).length;
  const restored = await ctx.service.restore({
    machine: 'machine-a',
    selector: { kind: 'all' },
    execute: true,
    previewId: restorePreview.previewId,
    reviewedTargets: [{ runId: 'run-a', generation: 3 }],
    operationId: 'zero-effect-restore',
  });
  const afterEffects = ctx.calls.filter((call) =>
    /^(pause|resume|start-resource|stop-resource):/.test(call),
  ).length;
  assert.equal(restored.ok, true);
  assert.equal(ctx.runs.get('run-a')?.park?.phase, 'restored');
  assert.equal(beforeEffects, afterEffects);
  ctx.deps.pauseRun = async () => {};
  const rePause = await ctx.service.preview({
    machine: 'machine-a',
    mode: 'orchestration',
    selector: { kind: 'all' },
  });
  assert.equal(rePause.runs[0]?.eligibility.eligible, true);
});

test('mixed restore stale session fails all selected preflight before zero-effect mutation', async () => {
  const ctx = mixedRestoreHarness();
  let inspections = 0;
  ctx.deps.inspectRecoveryHandle = async () => {
    inspections += 1;
    if (inspections >= 3) throw new Error('session disappeared at final preflight');
  };
  const preview = await ctx.service.restore({
    machine: 'machine-a',
    selector: { kind: 'all' },
  });
  const zeroBefore = structuredClone(ctx.runs.get('run-zero')!.park);
  await assert.rejects(
    () =>
      ctx.service.restore({
        machine: 'machine-a',
        selector: { kind: 'all' },
        execute: true,
        previewId: preview.previewId,
        reviewedTargets: preview.runs.map(({ runId, generation }) => ({ runId, generation })),
        operationId: 'mixed-stale',
      }),
    /session disappeared/,
  );
  assert.deepEqual(ctx.runs.get('run-zero')?.park, zeroBefore);
  assert.equal(
    ctx.calls.some((call) => call.startsWith('journal-write:mixed-stale')),
    false,
  );
  assert.equal(
    ctx.calls.some((call) => call.startsWith('resume:')),
    false,
  );
});

test('mixed restore journal failure returns complete batch with zero mutations and effects', async () => {
  const ctx = mixedRestoreHarness();
  const preview = await ctx.service.restore({
    machine: 'machine-a',
    selector: { kind: 'all' },
  });
  const before = new Map([...ctx.runs].map(([id, run]) => [id, structuredClone(run.park)]));
  ctx.deps.writeIntentJournal = async () => {
    throw new Error('restore journal unavailable');
  };
  const result = await ctx.service.restore({
    machine: 'machine-a',
    selector: { kind: 'all' },
    execute: true,
    previewId: preview.previewId,
    reviewedTargets: preview.runs.map(({ runId, generation }) => ({ runId, generation })),
    operationId: 'mixed-journal-failure',
  });
  assert.equal(result.records.length, 2);
  assert.equal(
    result.records.every((record) => record.phase === 'failed'),
    true,
  );
  assert.deepEqual(ctx.runs.get('run-zero')?.park, before.get('run-zero'));
  assert.deepEqual(ctx.runs.get('run-effect')?.park, before.get('run-effect'));
  assert.equal(
    ctx.calls.some((call) => call.startsWith('resume:')),
    false,
  );
  assert.equal(
    ctx.calls.some((call) => call.startsWith('start-resource:')),
    false,
  );
});

test('mixed restore success is one journaled idempotent batch', async () => {
  const ctx = mixedRestoreHarness();
  const preview = await ctx.service.restore({
    machine: 'machine-a',
    selector: { kind: 'all' },
  });
  const params = {
    machine: 'machine-a',
    selector: { kind: 'all' } as const,
    execute: true as const,
    previewId: preview.previewId,
    reviewedTargets: preview.runs.map(({ runId, generation }) => ({ runId, generation })),
    operationId: 'mixed-success',
  };
  const first = await ctx.service.restore(params);
  const second = await ctx.service.restore(params);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(first.records.length, 2);
  assert.equal(
    first.records.every((record) => record.phase === 'restored'),
    true,
  );
  assert.equal(ctx.calls.filter((call) => call === 'journal-write:mixed-success').length, 1);
  assert.equal(ctx.calls.filter((call) => call === 'resume:run-effect').length, 1);
  assert.equal(ctx.calls.includes('resume:run-zero'), false);
});

test('mixed restore partial intent crash journal repairs complete batch deterministically', async () => {
  const ctx = mixedRestoreHarness();
  const preview = await ctx.service.restore({
    machine: 'machine-a',
    selector: { kind: 'all' },
  });
  const persist = ctx.deps.persistRun;
  ctx.deps.persistRun = async (run, reason) => {
    if (run.id === 'run-effect' && reason === 'machine-restore-intent') {
      throw new Error('simulated crash during run intent write');
    }
    await persist(run, reason);
  };
  const params = {
    machine: 'machine-a',
    selector: { kind: 'all' } as const,
    execute: true as const,
    previewId: preview.previewId,
    reviewedTargets: preview.runs.map(({ runId, generation }) => ({ runId, generation })),
    operationId: 'mixed-crash',
  };
  const failed = await ctx.service.restore(params);
  assert.equal(failed.records.length, 2);
  assert.equal(
    failed.records.every((record) => record.phase === 'failed'),
    true,
  );
  const retry = await ctx.service.restore(params);
  assert.equal(
    retry.records.every((record) => record.phase === 'failed'),
    true,
  );
  await ctx.service.reconcile();
  assert.equal(ctx.runs.get('run-zero')?.park, null);
  assert.equal(ctx.runs.get('run-effect')?.park?.phase, 'parked');
  const repairedPreview = await ctx.service.restore({
    machine: 'machine-a',
    selector: { kind: 'all' },
  });
  assert.equal(repairedPreview.runs[0]?.eligibility.eligible, true);
});

test('atomic intent journal failure returns typed records without attaching partial intent', async () => {
  const ctx = harness([activeRun('run-a', 'slot-a'), activeRun('run-b', 'slot-b')]);
  ctx.deps.writeIntentJournal = async () => {
    throw new Error('journal unavailable');
  };
  const preview = await ctx.service.preview({
    machine: 'machine-a',
    mode: 'orchestration',
    selector: { kind: 'all' },
  });
  const result = await ctx.service.execute({
    machine: 'machine-a',
    mode: 'orchestration',
    previewId: preview.previewId,
    reviewedTargets: preview.runs.map(({ runId, generation }) => ({ runId, generation })),
    operationId: 'journal-failure',
  });
  assert.equal(result.records.length, 2);
  assert.equal(
    result.records.every((record) => record.phase === 'failed'),
    true,
  );
  assert.equal(ctx.runs.get('run-a')?.park, undefined);
  assert.equal(ctx.runs.get('run-b')?.park, undefined);
  assert.equal(
    ctx.calls.some((call) => call.startsWith('pause:')),
    false,
  );
});

test('ambiguous live runner target rejects final preflight with zero mutation', async () => {
  const ctx = harness([activeRun('run-a', 'slot-a')]);
  const preview = await ctx.service.preview({
    machine: 'machine-a',
    mode: 'release',
    selector: { kind: 'all' },
  });
  ctx.deps.inspectRecoveryHandle = async () => {
    throw new Error("Exact runner target ff-a:dev is ambiguous: found 2 live 'codex' processes");
  };

  await assert.rejects(
    () =>
      ctx.service.execute({
        machine: 'machine-a',
        mode: 'release',
        previewId: preview.previewId,
        reviewedTargets: preview.runs.map(({ runId, generation }) => ({ runId, generation })),
        operationId: 'ambiguous-runner-preflight',
      }),
    /ambiguous: found 2/,
  );
  assert.equal(ctx.runs.get('run-a')!.park, undefined);
  assert.equal(
    ctx.calls.some((call) => call.startsWith('pause:') || call.startsWith('stop-runner:')),
    false,
  );
});

test('concurrent pause/status/restore reads share one bounded machine pressure snapshot', async () => {
  const ctx = harness([activeRun('run-a', 'slot-a')]);
  let pressureCalls = 0;
  ctx.deps.pressure = async () => {
    pressureCalls += 1;
    return undefined;
  };
  await Promise.all([
    ctx.service.preview({
      machine: 'machine-a',
      mode: 'orchestration',
      selector: { kind: 'all' },
    }),
    ctx.service.status('machine-a'),
    ctx.service.restore({ machine: 'machine-a', selector: { kind: 'all' } }),
  ]);
  assert.equal(pressureCalls, 1);
});

test('orchestration pause leaves runner and resources live and is operation-id idempotent', async () => {
  const ctx = harness([activeRun('run-a', 'slot-a')]);
  const preview = await ctx.service.preview({
    machine: 'machine-a',
    mode: 'orchestration',
    selector: { kind: 'all' },
  });
  const params = {
    machine: 'machine-a',
    mode: 'orchestration' as const,
    previewId: preview.previewId,
    reviewedTargets: [{ runId: 'run-a', generation: 3 }],
    operationId: 'pause-once',
  };
  const first = await ctx.service.execute(params);
  const second = await ctx.service.execute(params);

  assert.equal(first.ok, true);
  assert.equal(first.records[0]?.phase, 'parked');
  assert.equal(first.records[0]?.residuals.runner, 'running');
  assert.equal(second.records[0]?.phase, 'parked');
  assert.equal(ctx.calls.filter((call) => call === 'pause:run-a').length, 1);
  assert.equal(
    ctx.calls.some((call) => call.startsWith('stop-runner:')),
    false,
  );
  assert.equal(
    ctx.calls.some((call) => call.startsWith('stop-resource:')),
    false,
  );
});

test('advisory emit failure never relabels a successful pause or restore', async () => {
  const ctx = harness([activeRun('run-a', 'slot-a')]);
  ctx.deps.emit = async () => {
    throw new Error('client disconnected');
  };
  const preview = await ctx.service.preview({
    machine: 'machine-a',
    mode: 'orchestration',
    selector: { kind: 'all' },
  });
  const paused = await ctx.service.execute({
    machine: 'machine-a',
    mode: 'orchestration',
    previewId: preview.previewId,
    reviewedTargets: [{ runId: 'run-a', generation: 3 }],
    operationId: 'emit-advisory-pause',
  });
  assert.equal(paused.ok, true);
  const restorePreview = await ctx.service.restore({
    machine: 'machine-a',
    selector: { kind: 'all' },
  });
  const restored = await ctx.service.restore({
    machine: 'machine-a',
    selector: { kind: 'all' },
    execute: true,
    previewId: restorePreview.previewId,
    reviewedTargets: [{ runId: 'run-a', generation: 3 }],
    operationId: 'emit-advisory-restore',
  });
  assert.equal(restored.ok, true);
});

test('successful parked cancel clears its durable park record only after cleanup settles', async () => {
  const ctx = harness([activeRun('run-a', 'slot-a')]);
  const preview = await ctx.service.preview({
    machine: 'machine-a',
    mode: 'orchestration',
    selector: { kind: 'all' },
  });
  await ctx.service.execute({
    machine: 'machine-a',
    mode: 'orchestration',
    previewId: preview.previewId,
    reviewedTargets: [{ runId: 'run-a', generation: 3 }],
    operationId: 'park-before-cancel',
  });

  assert.equal(await ctx.service.prepareRunCancel('run-a'), true);
  assert.equal(ctx.runs.get('run-a')?.park?.phase, 'cancelling');
  ctx.runs.get('run-a')!.status = 'cancelled';
  await ctx.service.finalizeRunCancel('run-a', [
    { name: 'runtime-capabilities', status: 'ok' },
    { name: 'slot-release', status: 'ok' },
  ]);
  assert.equal(ctx.runs.get('run-a')?.park, null);
  assert.equal(
    ctx.calls.some((call) => call.includes('machine-pause-cancel-cleared')),
    true,
  );
});

test('parked cancel retains residuals and errors when terminal cleanup is partial', async () => {
  const ctx = harness([activeRun('run-a', 'slot-a')]);
  const preview = await ctx.service.preview({
    machine: 'machine-a',
    mode: 'orchestration',
    selector: { kind: 'all' },
  });
  await ctx.service.execute({
    machine: 'machine-a',
    mode: 'orchestration',
    previewId: preview.previewId,
    reviewedTargets: [{ runId: 'run-a', generation: 3 }],
    operationId: 'park-before-partial-cancel',
  });

  await ctx.service.prepareRunCancel('run-a');
  ctx.runs.get('run-a')!.status = 'cancelled';
  await ctx.service.finalizeRunCancel('run-a', [
    { name: 'runtime-capabilities', status: 'failed', detail: 'lease cleanup failed' },
    { name: 'slot-release', status: 'failed', detail: 'worker still running' },
  ]);
  const park = ctx.runs.get('run-a')?.park;
  assert.equal(park?.phase, 'cancelled');
  assert.equal(park?.residuals.runner, 'running');
  assert.deepEqual(
    park?.errors.slice(-2).map((error) => [error.action, error.message]),
    [
      ['cancel.runtime-capabilities', 'lease cleanup failed'],
      ['cancel.slot-release', 'worker still running'],
    ],
  );
});

test('ci-watching orchestration pause and restore do not require current slot ownership', async () => {
  const ctx = harness([activeRun('run-ci', 'slot-ci', 'ci-watching')]);
  const loadFleet = ctx.deps.loadFleet;
  ctx.deps.loadFleet = async () => {
    const fleet = await loadFleet();
    return {
      ...fleet,
      slots: fleet.slots.map((slot) => ({ ...slot, currentRunId: null })),
    };
  };
  const pausePreview = await ctx.service.preview({
    machine: 'machine-a',
    mode: 'orchestration',
    selector: { kind: 'all' },
  });
  assert.deepEqual(pausePreview.runs[0]?.eligibility, {
    eligible: true,
    code: 'ELIGIBLE_ORCHESTRATION_PAUSE',
    reason: 'The run is in an idempotent monitoring phase; worker and resources stay live.',
  });
  const paused = await ctx.service.execute({
    machine: 'machine-a',
    mode: 'orchestration',
    previewId: pausePreview.previewId,
    reviewedTargets: [{ runId: 'run-ci', generation: 3 }],
    operationId: 'pause-ci-no-owner',
  });
  assert.equal(paused.ok, true);

  const restorePreview = await ctx.service.restore({
    machine: 'machine-a',
    selector: { kind: 'all' },
  });
  assert.equal(restorePreview.runs[0]?.eligibility.eligible, true);
  const restored = await ctx.service.restore({
    machine: 'machine-a',
    selector: { kind: 'all' },
    execute: true,
    previewId: restorePreview.previewId,
    reviewedTargets: [{ runId: 'run-ci', generation: 3 }],
    operationId: 'restore-ci-no-owner',
  });
  assert.equal(restored.ok, true);
  assert.equal(ctx.runs.get('run-ci')?.status, 'ci-watching');
  assert.equal(ctx.runs.get('run-ci')?.park?.restoredGeneration, 4);
});

test('release pause still requires exact current slot ownership', async () => {
  const ctx = harness([activeRun('run-ci', 'slot-ci', 'ci-watching')]);
  const loadFleet = ctx.deps.loadFleet;
  ctx.deps.loadFleet = async () => {
    const fleet = await loadFleet();
    return {
      ...fleet,
      slots: fleet.slots.map((slot) => ({ ...slot, currentRunId: null })),
    };
  };
  const preview = await ctx.service.preview({
    machine: 'machine-a',
    mode: 'release',
    selector: { kind: 'all' },
  });
  assert.deepEqual(preview.runs[0]?.eligibility, {
    eligible: false,
    code: 'SLOT_OWNERSHIP_CHANGED',
    reason: "slot 'slot-ci' is owned by 'no run'",
  });
});

test('different reviewed batches on one machine execute through one promise tail', async () => {
  const ctx = harness([activeRun('run-a', 'slot-a'), activeRun('run-b', 'slot-b')]);
  const previewA = await ctx.service.preview({
    machine: 'machine-a',
    mode: 'orchestration',
    selector: { kind: 'include', runIds: ['run-a'] },
  });
  const previewB = await ctx.service.preview({
    machine: 'machine-a',
    mode: 'orchestration',
    selector: { kind: 'include', runIds: ['run-b'] },
  });
  let enterFirst!: () => void;
  let releaseFirst!: () => void;
  const firstEntered = new Promise<void>((resolve) => {
    enterFirst = resolve;
  });
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const originalPause = ctx.deps.pauseRun;
  ctx.deps.pauseRun = async (runId, emit) => {
    if (runId === 'run-a') {
      enterFirst();
      await firstGate;
    }
    await originalPause(runId, emit);
  };
  const executeA = ctx.service.execute({
    machine: 'machine-a',
    mode: 'orchestration',
    previewId: previewA.previewId,
    reviewedTargets: [{ runId: 'run-a', generation: 3 }],
    operationId: 'locked-a',
  });
  await firstEntered;
  const executeB = ctx.service.execute({
    machine: 'machine-a',
    mode: 'orchestration',
    previewId: previewB.previewId,
    reviewedTargets: [{ runId: 'run-b', generation: 3 }],
    operationId: 'locked-b',
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ctx.calls.includes('pause:run-b'), false);

  releaseFirst();
  const [resultA, resultB] = await Promise.all([executeA, executeB]);
  assert.equal(resultA.ok, true);
  assert.equal(resultB.ok, true);
  assert.equal(ctx.calls.indexOf('pause:run-a') < ctx.calls.indexOf('pause:run-b'), true);
});

test('external machine transition cannot enter while release effects hold the machine tail', async () => {
  const ctx = harness([activeRun('run-a', 'slot-a')]);
  let releaseStop!: () => void;
  let stopEntered!: () => void;
  const stopGate = new Promise<void>((resolve) => {
    releaseStop = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    stopEntered = resolve;
  });
  ctx.deps.stopRunner = async () => {
    stopEntered();
    await stopGate;
  };
  const preview = await ctx.service.preview({
    machine: 'machine-a',
    mode: 'release',
    selector: { kind: 'all' },
  });
  const executing = ctx.service.execute({
    machine: 'machine-a',
    mode: 'release',
    previewId: preview.previewId,
    reviewedTargets: [{ runId: 'run-a', generation: 3 }],
    operationId: 'hold-machine-tail',
  });
  await entered;
  let externalEntered = false;
  const external = withMachineRunTransition('machine-a', async () => {
    externalEntered = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(externalEntered, false);
  releaseStop();
  await executing;
  await external;
  assert.equal(externalEntered, true);
});

test('release pause continues other runs after a partial resource failure without rollback', async () => {
  const ctx = harness([activeRun('run-a', 'slot-a'), activeRun('run-b', 'slot-b')]);
  ctx.deps.stopResource = async (slotId, resourceId) => {
    ctx.calls.push(`stop-resource:${slotId}:${resourceId}`);
    return slotId === 'slot-a' ? { ok: false, detail: 'busy' } : { ok: true };
  };
  const preview = await ctx.service.preview({
    machine: 'machine-a',
    mode: 'release',
    selector: { kind: 'all' },
  });
  const result = await ctx.service.execute({
    machine: 'machine-a',
    mode: 'release',
    previewId: preview.previewId,
    reviewedTargets: preview.runs.map(({ runId, generation }) => ({ runId, generation })),
    operationId: 'partial-release',
  });

  assert.equal(result.ok, false);
  assert.equal(result.outcome, 'partial');
  assert.equal(ctx.runs.get('run-a')!.park?.phase, 'partial');
  assert.equal(ctx.runs.get('run-b')!.park?.phase, 'parked');
  assert.equal(ctx.calls.includes('stop-runner:run-b'), true);
  assert.equal(ctx.calls.includes('stop-resource:slot-b:browser-cdp'), true);
});

test('restore preserves a live runner and held leases after failure before resource stop', async () => {
  const run = activeRun('run-a', 'slot-a');
  const ctx = harness([run]);
  ctx.deps.capabilityStatus = async () => ({
    slotId: 'slot-a',
    project: 'test',
    catalog: [
      {
        id: 'browser-cdp',
        project: 'test',
        label: 'Browser',
        description: 'Browser',
        version: '1',
        sharePolicy: 'exclusive',
        actions: {
          acquire: { kind: 'resource', resourceId: 'browser-cdp', action: 'boot' },
          health: { kind: 'resource', resourceId: 'browser-cdp', action: 'health' },
          release: { kind: 'resource', resourceId: 'browser-cdp', action: 'shutdown' },
        },
        cost: { class: 'high', resources: [] },
        releaseEffects: [],
        provenance: { project: 'test', providerId: 'browser-cdp', version: '1', digest: 'x' },
        availability: { state: 'available' },
      },
    ],
    leases: [
      {
        id: 'lease-browser',
        slotId: 'slot-a',
        project: 'test',
        capabilityId: 'browser-cdp',
        owner: { runId: 'run-a' },
        state: 'acquired',
        referenceCount: 1,
        parameters: {},
        provenance: { project: 'test', providerId: 'browser-cdp', version: '1', digest: 'x' },
        health: { state: 'healthy' },
        dependencyLeaseIds: [],
        updatedAt: '2026-08-21T00:00:00.000Z',
      },
    ],
    proofPlans: {
      'run-a': {
        version: 1,
        slotId: 'slot-a',
        ownerRunId: 'run-a',
        createdAt: '2026-08-21T00:00:00.000Z',
        requirements: [{ capabilityId: 'browser-cdp', reason: 'visual proof', mode: 'visual' }],
      },
    },
    events: [],
  });
  ctx.deps.stopRunner = async () => {
    throw new Error('graceful stop timed out');
  };
  const preview = await ctx.service.preview({
    machine: 'machine-a',
    mode: 'release',
    selector: { kind: 'all' },
  });
  const paused = await ctx.service.execute({
    machine: 'machine-a',
    mode: 'release',
    previewId: preview.previewId,
    reviewedTargets: [{ runId: 'run-a', generation: 3 }],
    operationId: 'stop-failed',
  });
  assert.equal(paused.outcome, 'failed');
  assert.equal(ctx.runs.get('run-a')?.park?.resourceManifest.capabilityLeases[0]?.state, 'held');

  const restorePreview = await ctx.service.restore({
    machine: 'machine-a',
    selector: { kind: 'all' },
  });
  const restored = await ctx.service.restore({
    machine: 'machine-a',
    selector: { kind: 'all' },
    execute: true,
    previewId: restorePreview.previewId,
    reviewedTargets: [{ runId: 'run-a', generation: 3 }],
    operationId: 'restore-after-stop-failure',
  });
  assert.equal(restored.ok, true);
  assert.equal(
    ctx.calls.some((call) => call.startsWith('acquire-capability:')),
    false,
  );
  assert.equal(
    ctx.calls.some((call) => call.startsWith('start-resource:')),
    false,
  );
  assert.equal(ctx.calls.includes('reload-runner:run-a'), false);
  assert.equal(ctx.calls.includes('resume:run-a'), true);
});

test('partial live runner with a different exact session is rejected before resume', async () => {
  const ctx = harness([activeRun('run-a', 'slot-a')]);
  ctx.deps.stopRunner = async () => {
    throw new Error('runner stayed live');
  };
  const pausePreview = await ctx.service.preview({
    machine: 'machine-a',
    mode: 'release',
    selector: { kind: 'all' },
  });
  await ctx.service.execute({
    machine: 'machine-a',
    mode: 'release',
    previewId: pausePreview.previewId,
    reviewedTargets: [{ runId: 'run-a', generation: 3 }],
    operationId: 'partial-live',
  });
  ctx.deps.inspectRecoveryHandle = async (_run, _handle, expected) => {
    assert.equal(expected, 'stopped-or-live');
    throw new Error('live runner session id/path does not match recovery handle');
  };
  const preview = await ctx.service.restore({
    machine: 'machine-a',
    selector: { kind: 'all' },
  });
  assert.equal(preview.runs[0]?.eligibility.code, 'RECOVERY_HANDLE_STALE');
  assert.equal(ctx.calls.includes('resume:run-a'), false);
});

test('partial resource restore boots only resources that actually stopped', async () => {
  const ctx = harness([activeRun('run-a', 'slot-a')]);
  const states = new Map<string, SlotResource['status']>([
    ['browser-cdp', 'running'],
    ['dev-server', 'running'],
  ]);
  ctx.deps.observeResources = async () =>
    [...states].map(([id, status]) => ({ ...runningResource(id), status }));
  ctx.deps.stopResource = async (_slotId, resourceId) => {
    ctx.calls.push(`stop-resource:slot-a:${resourceId}`);
    if (resourceId === 'browser-cdp') return { ok: false, detail: 'busy' };
    states.set(resourceId, 'stopped');
    return { ok: true };
  };
  ctx.deps.startResource = async (_slotId, resourceId) => {
    ctx.calls.push(`start-resource:slot-a:${resourceId}`);
    states.set(resourceId, 'running');
    return { ok: true };
  };
  const preview = await ctx.service.preview({
    machine: 'machine-a',
    mode: 'release',
    selector: { kind: 'all' },
  });
  await ctx.service.execute({
    machine: 'machine-a',
    mode: 'release',
    previewId: preview.previewId,
    reviewedTargets: [{ runId: 'run-a', generation: 3 }],
    operationId: 'partial-resources',
  });
  const restorePreview = await ctx.service.restore({
    machine: 'machine-a',
    selector: { kind: 'all' },
  });
  const restored = await ctx.service.restore({
    machine: 'machine-a',
    selector: { kind: 'all' },
    execute: true,
    previewId: restorePreview.previewId,
    reviewedTargets: [{ runId: 'run-a', generation: 3 }],
    operationId: 'restore-partial-resources',
  });

  assert.equal(restored.ok, true);
  assert.equal(ctx.calls.includes('start-resource:slot-a:browser-cdp'), false);
  assert.equal(ctx.calls.includes('start-resource:slot-a:dev-server'), true);
  assert.equal(ctx.calls.includes('reload-runner:run-a'), true);
  assert.equal(ctx.calls.includes('resume:run-a'), true);
});

test('release restore starts only the manifest, reloads the exact session, then resumes generation', async () => {
  const ctx = harness([activeRun('run-a', 'slot-a')]);
  const pausePreview = await ctx.service.preview({
    machine: 'machine-a',
    mode: 'release',
    selector: { kind: 'all' },
  });
  await ctx.service.execute({
    machine: 'machine-a',
    mode: 'release',
    previewId: pausePreview.previewId,
    reviewedTargets: [{ runId: 'run-a', generation: 3 }],
    operationId: 'release-a',
  });
  const restorePreview = await ctx.service.restore({
    machine: 'machine-a',
    selector: { kind: 'all' },
  });
  const result = await ctx.service.restore({
    machine: 'machine-a',
    selector: { kind: 'all' },
    execute: true,
    previewId: restorePreview.previewId,
    reviewedTargets: [{ runId: 'run-a', generation: 3 }],
    operationId: 'restore-a',
  });

  assert.equal(result.ok, true);
  assert.equal(ctx.runs.get('run-a')!.park?.phase, 'restored');
  assert.equal(ctx.runs.get('run-a')!.park?.restoredGeneration, 4);
  assert.equal(
    ctx.runs.get('run-a')!.park?.recoveryProof?.sessionId,
    ctx.runs.get('run-a')!.park?.recoveryHandle?.sessionId,
  );
  assert.equal(ctx.runs.get('run-a')!.park?.recoveryProof?.acknowledgement.kind, 'structured');
  const start = ctx.calls.indexOf('start-resource:slot-a:browser-cdp');
  const reload = ctx.calls.indexOf('reload-runner:run-a');
  const resume = ctx.calls.indexOf('resume:run-a');
  assert.equal(start >= 0, true);
  assert.equal(start < reload && reload < resume, true);
  assert.match(
    ctx.calls.find((call) => call.startsWith('reload-prompt:')) ?? '',
    /Continue Farmslot run run-a after machine restore[\s\S]*Prior step: monitor[\s\S]*Do not start a fresh run/,
  );
  assert.equal(
    ctx.calls.filter((call) => call.startsWith('start-resource:')).length,
    1,
    'restore must not widen beyond the observed-running manifest',
  );
});

test('stale restore session fails final preflight before capability acquire or resource boot', async () => {
  const ctx = harness([activeRun('run-a', 'slot-a')]);
  const pausePreview = await ctx.service.preview({
    machine: 'machine-a',
    mode: 'release',
    selector: { kind: 'all' },
  });
  await ctx.service.execute({
    machine: 'machine-a',
    mode: 'release',
    previewId: pausePreview.previewId,
    reviewedTargets: [{ runId: 'run-a', generation: 3 }],
    operationId: 'release-before-stale-session',
  });
  const restorePreview = await ctx.service.restore({
    machine: 'machine-a',
    selector: { kind: 'all' },
  });
  ctx.deps.inspectRecoveryHandle = async () => {
    throw new Error('persisted session path disappeared');
  };
  await assert.rejects(
    () =>
      ctx.service.restore({
        machine: 'machine-a',
        selector: { kind: 'all' },
        execute: true,
        previewId: restorePreview.previewId,
        reviewedTargets: [{ runId: 'run-a', generation: 3 }],
        operationId: 'stale-session-restore',
      }),
    /stale|session path disappeared/,
  );
  assert.equal(
    ctx.calls.some((call) => call.startsWith('acquire-capability:')),
    false,
  );
  assert.equal(
    ctx.calls.some((call) => call.startsWith('start-resource:')),
    false,
  );
});

test('parked release session appearing after final preflight becomes partial without resume', async () => {
  const ctx = harness([activeRun('run-a', 'slot-a')]);
  const pausePreview = await ctx.service.preview({
    machine: 'machine-a',
    mode: 'release',
    selector: { kind: 'all' },
  });
  await ctx.service.execute({
    machine: 'machine-a',
    mode: 'release',
    previewId: pausePreview.previewId,
    reviewedTargets: [{ runId: 'run-a', generation: 3 }],
    operationId: 'release-before-late-session',
  });
  let inspections = 0;
  ctx.deps.inspectRecoveryHandle = async (_run, _handle, expected) => {
    inspections += 1;
    assert.equal(expected, 'stopped');
    if (inspections >= 4) throw new Error('runner became live after final preflight');
  };
  const restorePreview = await ctx.service.restore({
    machine: 'machine-a',
    selector: { kind: 'all' },
  });
  const result = await ctx.service.restore({
    machine: 'machine-a',
    selector: { kind: 'all' },
    execute: true,
    previewId: restorePreview.previewId,
    reviewedTargets: [{ runId: 'run-a', generation: 3 }],
    operationId: 'late-session',
  });
  assert.equal(result.ok, false);
  assert.equal(ctx.runs.get('run-a')?.park?.phase, 'partial');
  assert.equal(ctx.calls.includes('resume:run-a'), false);
});

test('structured continuation rejection prevents generation resume', async () => {
  const ctx = harness([activeRun('run-a', 'slot-a')]);
  const pausePreview = await ctx.service.preview({
    machine: 'machine-a',
    mode: 'release',
    selector: { kind: 'all' },
  });
  await ctx.service.execute({
    machine: 'machine-a',
    mode: 'release',
    previewId: pausePreview.previewId,
    reviewedTargets: [{ runId: 'run-a', generation: 3 }],
    operationId: 'release-before-rejected-acceptance',
  });
  const restorePreview = await ctx.service.restore({
    machine: 'machine-a',
    selector: { kind: 'all' },
  });
  let continuationPrompt = '';
  ctx.deps.reloadRunner = async (_run, _handle, prompt) => {
    continuationPrompt = prompt;
    throw new Error('structured prompt acceptance was not observed');
  };
  const result = await ctx.service.restore({
    machine: 'machine-a',
    selector: { kind: 'all' },
    execute: true,
    previewId: restorePreview.previewId,
    reviewedTargets: [{ runId: 'run-a', generation: 3 }],
    operationId: 'rejected-acceptance',
  });
  assert.match(continuationPrompt, /Continue Farmslot run run-a/);
  assert.equal(result.ok, false);
  assert.equal(ctx.runs.get('run-a')?.park?.phase, 'partial');
  assert.equal(ctx.runs.get('run-a')?.engineState?.generation, 3);
  assert.equal(ctx.calls.includes('resume:run-a'), false);
});

test('resume redrive rejection stays paused, advances the fence, and never reports restored', async () => {
  const ctx = harness([activeRun('run-a', 'slot-a')]);
  const pausePreview = await ctx.service.preview({
    machine: 'machine-a',
    mode: 'orchestration',
    selector: { kind: 'all' },
  });
  await ctx.service.execute({
    machine: 'machine-a',
    mode: 'orchestration',
    previewId: pausePreview.previewId,
    reviewedTargets: [{ runId: 'run-a', generation: 3 }],
    operationId: 'pause-before-redrive-failure',
  });
  const restorePreview = await ctx.service.restore({
    machine: 'machine-a',
    selector: { kind: 'all' },
  });
  ctx.deps.resumeRun = async (runId) => {
    const run = ctx.runs.get(runId)!;
    run.engineState = { ...run.engineState, generation: 4 };
    run.status = 'paused';
    throw new Error('engine redrive acknowledgement failed');
  };
  const result = await ctx.service.restore({
    machine: 'machine-a',
    selector: { kind: 'all' },
    execute: true,
    previewId: restorePreview.previewId,
    reviewedTargets: [{ runId: 'run-a', generation: 3 }],
    operationId: 'redrive-failure',
  });
  const park = ctx.runs.get('run-a')!.park!;
  assert.equal(result.ok, false);
  assert.equal(ctx.runs.get('run-a')?.status, 'paused');
  assert.equal(park.phase, 'partial');
  assert.equal(park.generation, 4);
  assert.equal(park.restoredAt, undefined);
  assert.equal(park.restoredGeneration, undefined);
});

test('restart reconciliation marks interrupted release records partial with residuals', async () => {
  const run = activeRun('run-a', 'slot-a');
  run.status = 'paused';
  run.park = {
    version: 1,
    operationId: 'interrupted',
    previewId: 'pause-x',
    runId: run.id,
    generation: 3,
    machine: 'machine-a',
    slotId: 'slot-a',
    mode: 'release',
    phase: 'resources-stopping',
    prePauseStatus: 'monitoring',
    prePauseCurrentStep: { index: 0, name: 'monitor', status: 'running' },
    resourceManifest: {
      capturedAt: '2026-08-21T00:00:00.000Z',
      resources: [
        {
          resourceId: 'browser-cdp',
          label: 'Browser',
          type: 'browser',
          observedStatus: 'running',
          phase: 'stopping',
          capabilityLeaseIds: [],
        },
      ],
      capabilityLeases: [],
    },
    recoveryHandle: recoveryHandle(run.id, 'slot-a'),
    errors: [],
    residuals: { runner: 'unknown', resources: [] },
    createdAt: '2026-08-21T00:00:00.000Z',
    updatedAt: '2026-08-21T00:00:00.000Z',
  } satisfies MachineParkRecord;
  const ctx = harness([run]);
  ctx.deps.runnerRunning = async () => 'running';

  const reconciled = await ctx.service.reconcile();
  assert.deepEqual(reconciled, { reconciled: 1, partial: 1 });
  assert.equal(ctx.runs.get('run-a')!.park?.phase, 'partial');
  assert.equal(ctx.runs.get('run-a')!.park?.residuals.runner, 'running');
  assert.equal(ctx.runs.get('run-a')!.park?.residuals.resources[0]?.state, 'running');
});

test('restart reconciliation recovers a pre-terminal cancelling intent back to parked', async () => {
  const run = activeRun('run-a', 'slot-a');
  run.status = 'paused';
  run.park = {
    version: 1,
    operationId: 'cancel-interrupted',
    previewId: 'pause-x',
    runId: run.id,
    generation: 3,
    machine: 'machine-a',
    slotId: 'slot-a',
    mode: 'orchestration',
    phase: 'cancelling',
    prePauseStatus: 'monitoring',
    prePauseCurrentStep: { index: 0, name: 'monitor', status: 'running' },
    resourceManifest: {
      capturedAt: '2026-08-21T00:00:00.000Z',
      resources: [],
      capabilityLeases: [],
    },
    recoveryHandle: null,
    errors: [],
    residuals: { runner: 'running', resources: [] },
    createdAt: '2026-08-21T00:00:00.000Z',
    updatedAt: '2026-08-21T00:00:00.000Z',
  };
  const ctx = harness([run]);

  const result = await ctx.service.reconcile();
  assert.deepEqual(result, { reconciled: 1, partial: 0 });
  assert.equal(ctx.runs.get('run-a')?.park?.phase, 'parked');
});
