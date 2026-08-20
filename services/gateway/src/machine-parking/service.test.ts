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

import { type MachineParkingDependencies, MachineParkingService } from './service.js';

function recoveryHandle(runId: string, slotId: string): MachinePauseRecoveryHandle {
  return {
    version: 1,
    runnerId: 'claude',
    contextId: 'primary',
    sessionId: `session-${runId}`,
    sessionPath: `/sessions/${runId}.jsonl`,
    target: { session: slotId, window: 'worker', target: `${slotId}:worker` },
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
    pauseRun: async (runId, emit) => {
      calls.push(`pause:${runId}`);
      runs.get(runId)!.status = 'paused';
      emit('run.updated', { runId });
    },
    resumeRun: async (runId, emit) => {
      calls.push(`resume:${runId}`);
      const run = runs.get(runId)!;
      run.status = run.park!.prePauseStatus;
      run.engineState = {
        ...run.engineState,
        generation: (run.engineState?.generation ?? 0) + 1,
      };
      emit('run.updated', { runId });
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
  const handleCalls = new Map<string, number>();
  ctx.deps.resolveRecoveryHandle = async (run) => {
    const count = (handleCalls.get(run.id) ?? 0) + 1;
    handleCalls.set(run.id, count);
    if (run.id === 'run-b' && count === 2) {
      throw new Error('Persisted runner session path is unavailable');
    }
    return recoveryHandle(run.id, run.slotId!);
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

test('ambiguous live runner target rejects final preflight with zero mutation', async () => {
  const ctx = harness([activeRun('run-a', 'slot-a')]);
  const preview = await ctx.service.preview({
    machine: 'machine-a',
    mode: 'release',
    selector: { kind: 'all' },
  });
  let calls = 0;
  ctx.deps.resolveRecoveryHandle = async (run) => {
    calls += 1;
    if (calls === 2) {
      throw new Error("Exact runner target ff-a:dev is ambiguous: found 2 live 'codex' processes");
    }
    return recoveryHandle(run.id, run.slotId!);
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
