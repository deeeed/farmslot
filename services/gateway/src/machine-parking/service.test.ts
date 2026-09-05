import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  MachineParkRecord,
  MachinePauseRecoveryHandle,
  Run,
  RuntimeCapabilityCatalogEntry,
  RuntimeCapabilityStatusResult,
  SlotResource,
} from '@farmslot/protocol';

import { gateParkResumeAcknowledgement } from '../methods/run/lifecycle-control.js';
import { isGateParkInFlightOrFreed } from '../run-engine/park-slot-binding.js';
import { makeRun } from '../run-engine/test-fixtures.js';
import { withMachineRunTransition } from '../run-lifecycle/transition-coordinator.js';

import { assertValidJournal, type MachineParkingIntentJournal } from './journal.js';
import {
  type MachineParkingDependencies,
  MachineParkingService,
  type ParkWorkspaceInspection,
  type RunnerReloadInspection,
} from './service.js';

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
  /** Slot -> owning run id, mutated by freeSlotOwnership and read by loadFleet. */
  slotOwners: Map<string, string | null>;
  slotLifecycles: Map<string, string>;
  /** Per-run override for the declared runner graceful-stop + session-reload capability. */
  reloadSupport: Map<string, RunnerReloadInspection>;
  /** Observed runner liveness per run, as residual observation reads it. */
  runnerStates: Map<string, 'running' | 'stopped' | 'unknown'>;
  /** Slot -> working-tree branch identity, mutated by detachParkedWorkspace. */
  workspaces: Map<string, ParkWorkspaceInspection>;
  /** Durable free-slot journals the harness wrote, keyed machine:operationId. */
  freeSlotJournals: Set<string>;
}

function harness(initialRuns: Run[]): Harness {
  const runs = new Map(initialRuns.map((run) => [run.id, structuredClone(run)]));
  const runnerStates = new Map<string, 'running' | 'stopped' | 'unknown'>(
    initialRuns.map((run) => [run.id, 'running']),
  );
  const calls: string[] = [];
  const slotOwners = new Map<string, string | null>(
    initialRuns.filter((run) => run.slotId).map((run) => [run.slotId!, run.id]),
  );
  const reloadSupport = new Map<string, RunnerReloadInspection>();
  const workspaces = new Map<string, ParkWorkspaceInspection>(
    initialRuns
      .filter((run) => run.slotId)
      .map((run) => [
        run.slotId!,
        { branch: `work/${run.id}`, headSha: `sha-${run.id}`, dirtyPaths: [] },
      ]),
  );
  const slotLifecycles = new Map<string, string>();
  const freeSlotJournals = new Set<string>();
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
            currentRunId: slotOwners.get(run.slotId!) ?? null,
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
    writeIntentJournal: async (kind, records, scopeId) => {
      calls.push(`journal-write:${records[0]!.operationId}`);
      if (kind === 'free-slot') calls.push(`free-journal-write:${records[0]!.operationId}`);
      if (kind === 'free-slot') {
        freeSlotJournals.add(`${records[0]!.machine}:${records[0]!.operationId}:${scopeId ?? ''}`);
      }
      const first = records[0]!;
      const journal: MachineParkingIntentJournal = {
        version: 1,
        kind,
        machine: first.machine,
        operationId: first.operationId,
        ...(scopeId ? { scopeId } : {}),
        records: structuredClone(records),
      };
      // The REAL validator, not a permissive double. An in-memory Map that
      // accepts anything lets the writer and the on-disk validator disagree and
      // still pass every unit test — which is exactly how a required
      // `detachedAt` shipped and quarantined every journal on reload.
      assertValidJournal(journal);
      journals.set(`${first.machine}:${kind}:${first.operationId}:${scopeId ?? ''}`, journal);
    },
    deleteIntentJournal: async (machine, kind, operationId, scopeId) => {
      calls.push(`journal-delete:${operationId}`);
      if (kind === 'free-slot') calls.push(`free-journal-delete:${operationId}`);
      if (kind === 'free-slot') {
        freeSlotJournals.delete(`${machine}:${operationId}:${scopeId ?? ''}`);
      }
      journals.delete(`${machine}:${kind}:${operationId}:${scopeId ?? ''}`);
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
    inspectParkWorkspace: async (run) => {
      calls.push(`inspect-workspace:${run.id}`);
      const workspace = workspaces.get(run.slotId!);
      if (!workspace) throw new Error(`no workspace fixture for slot ${run.slotId}`);
      return structuredClone(workspace);
    },
    detachParkedWorkspace: async (run, expected) => {
      calls.push(`detach-workspace:${run.slotId}:${expected.branch}`);
      const workspace = workspaces.get(run.slotId!);
      if (!workspace) throw new Error(`no workspace fixture for slot ${run.slotId}`);
      if (workspace.branch !== null && workspace.branch !== expected.branch) {
        throw new Error(`workspace moved to ${workspace.branch}`);
      }
      if (workspace.dirtyPaths.length > 0) throw new Error('workspace became dirty');
      workspaces.set(run.slotId!, { ...workspace, branch: null });
    },
    slotRow: async (slotId) => ({
      slot: slotId,
      current_run_id: slotOwners.get(slotId) ?? null,
      lifecycle: slotLifecycles.get(slotId) ?? (slotOwners.get(slotId) ? 'busy' : 'ready'),
    }),
    reattachParkedWorkspace: async (run, workspace) => {
      calls.push(`reattach-workspace:${run.slotId}:${workspace.branch}`);
      const current = workspaces.get(run.slotId!);
      if (!current) throw new Error(`no workspace fixture for slot ${run.slotId}`);
      workspaces.set(run.slotId!, { ...current, branch: workspace.branch });
    },
    inspectRunnerReload: async (run) => {
      calls.push(`inspect-reload:${run.id}`);
      return (
        reloadSupport.get(run.id) ?? {
          runnerId: run.metrics.runner ?? 'unknown',
          supported: true,
        }
      );
    },
    freeSlotOwnership: async (slotId, runId) => {
      calls.push(`free-slot:${slotId}:${runId}`);
      if (slotOwners.get(slotId) !== runId) return false;
      slotOwners.set(slotId, null);
      return true;
    },
    resolveRecoveryHandle: async (run) => recoveryHandle(run.id, run.slotId!),
    inspectRecoveryHandle: async () => {},
    pauseRun: async (runId, emit) => {
      calls.push(`pause:${runId}`);
      const run = runs.get(runId)!;
      // Mirrors runPauseTransitionLocked's gate-park branch: a park that frees
      // the slot leaves the run at its gate so the decision stays answerable.
      if (!(run.park?.mode === 'release' && run.park.slotDisposition === 'freed')) {
        run.status = 'paused';
      }
      emit('run.updated', { runId });
    },
    resumeRun: async (runId, emit) => {
      calls.push(`resume:${runId}`);
      const run = runs.get(runId)!;
      // The REAL gate-park decision, not a re-implementation. A double that
      // decided this for itself is exactly how the resume side kept demanding
      // `paused` after restore had been taught to admit a gate park.
      const gateParkHold = gateParkResumeAcknowledgement(run, () => '2026-08-21T00:00:31.000Z');
      if (gateParkHold) {
        emit('run.updated', { runId });
        return gateParkHold;
      }
      // The ordinary path still refuses a run that is not paused, matching
      // `runResumeTransitionLocked`.
      if (run.status !== 'paused') {
        throw new Error(`Run ${runId} is not paused (status=${run.status})`);
      }
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
        status: run.status,
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
  return {
    service: new MachineParkingService(deps),
    runs,
    calls,
    deps,
    slotOwners,
    slotLifecycles,
    reloadSupport,
    runnerStates,
    workspaces,
    freeSlotJournals,
  };
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
  assert.equal(ctx.runs.get('run-zero')?.park?.phase, 'restored');
  assert.equal(ctx.runs.get('run-zero')?.park?.operationId, 'mixed-crash');
  assert.equal(ctx.runs.get('run-effect')?.park?.phase, 'parked');
  const repairedPreview = await ctx.service.restore({
    machine: 'machine-a',
    selector: { kind: 'all' },
  });
  assert.equal(repairedPreview.runs[0]?.eligibility.eligible, true);
});

test('startup settles durable zero-effect restore intent after crash before member settlement', async () => {
  const ctx = mixedRestoreHarness();
  const zero = ctx.runs.get('run-zero')!;
  const effect = ctx.runs.get('run-effect')!;
  zero.park = {
    ...zero.park!,
    operationId: 'post-intent-crash',
    previewId: 'post-intent-preview',
    restoreDisposition: 'zero-effect',
  };
  effect.park = {
    ...effect.park!,
    operationId: 'post-intent-crash',
    previewId: 'post-intent-preview',
    restoreDisposition: 'effectful',
    phase: 'resources-restoring',
  };

  await ctx.service.reconcile();
  assert.equal(zero.park?.phase, 'restored');
  assert.equal(zero.park?.operationId, 'post-intent-crash');
  assert.equal(zero.park?.previewId, 'post-intent-preview');
  assert.equal(zero.park?.generation, 3);
  assert.equal(effect.park?.phase, 'parked');

  const retry = await ctx.service.restore({
    machine: 'machine-a',
    selector: { kind: 'all' },
    execute: true,
    previewId: 'post-intent-preview',
    reviewedTargets: [
      { runId: 'run-zero', generation: 3 },
      { runId: 'run-effect', generation: 3 },
    ],
    operationId: 'post-intent-crash',
  });
  assert.equal(retry.records.length, 2);
  await assert.rejects(
    () =>
      ctx.service.restore({
        machine: 'machine-a',
        selector: { kind: 'all' },
        execute: true,
        previewId: 'post-intent-preview',
        reviewedTargets: [{ runId: 'run-zero', generation: 3 }],
        operationId: 'post-intent-crash',
      }),
    /reviewedTargets do not exactly match/,
  );
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

// ─── ADR-054 free-slot at an operator wait ───

function gateHeldRun(id: string, slotId: string): Run {
  return makeRun({
    id,
    familyId: `family-${id}`,
    flowType: 'dev',
    mode: 'autonomous',
    status: 'human-gating',
    slotId,
    steps: [
      { name: 'complete', status: 'done', outputs: { slotDisposition: 'gate-held' } },
      { name: 'human-gate', status: 'running' },
    ],
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

test('release preview accepts a gate-held run with a declared session reload and marks its slot freed', async () => {
  const ctx = harness([gateHeldRun('run-gate', 'slot-a')]);

  const preview = await ctx.service.preview({
    machine: 'machine-a',
    mode: 'release',
    selector: { kind: 'include', runIds: ['run-gate'] },
  });

  const entry = preview.runs.find((run) => run.runId === 'run-gate')!;
  assert.equal(entry.eligibility.eligible, true);
  assert.equal(entry.eligibility.code, 'ELIGIBLE_GATE_RELEASE_PAUSE');
  assert.equal(entry.slotDisposition, 'freed');
  assert.equal(preview.eligibleCount, 1);
});

test('release preview rejects a gate-held run whose runner declares no session reload', async () => {
  const ctx = harness([gateHeldRun('run-gate', 'slot-a')]);
  ctx.reloadSupport.set('run-gate', {
    runnerId: 'scripted',
    supported: false,
    reason: "runner 'scripted' declares no persisted session reload capability",
  });

  const preview = await ctx.service.preview({
    machine: 'machine-a',
    mode: 'release',
    selector: { kind: 'include', runIds: ['run-gate'] },
  });

  const entry = preview.runs.find((run) => run.runId === 'run-gate')!;
  assert.equal(entry.eligibility.eligible, false);
  assert.equal(entry.eligibility.code, 'RUNNER_RELOAD_UNSUPPORTED');
  assert.equal(entry.slotDisposition, 'freed');
  assert.equal(entry.recoveryPolicy.kind, 'runner-session-reload');
  assert.equal(entry.recoveryPolicy.supported, false);
  // Fail closed before any side effect: no manifest capture, no handle probe.
  assert.equal(
    ctx.calls.some((call) => call.startsWith('observe:')),
    false,
  );
  assert.equal(
    ctx.calls.some((call) => call.startsWith('stop-runner:')),
    false,
  );
});

test('orchestration preview refuses a gate-held run instead of stranding its gate', async () => {
  const ctx = harness([gateHeldRun('run-gate', 'slot-a')]);

  const preview = await ctx.service.preview({
    machine: 'machine-a',
    mode: 'orchestration',
    selector: { kind: 'include', runIds: ['run-gate'] },
  });

  const entry = preview.runs.find((run) => run.runId === 'run-gate')!;
  assert.equal(entry.eligibility.eligible, false);
  assert.equal(entry.eligibility.code, 'GATE_PARK_REQUIRES_RELEASE');
  assert.equal(entry.slotDisposition, 'retained');
});

test('executing a gate park persists the record before side effects and frees the slot', async () => {
  const ctx = harness([gateHeldRun('run-gate', 'slot-a')]);
  const preview = await ctx.service.preview({
    machine: 'machine-a',
    mode: 'release',
    selector: { kind: 'include', runIds: ['run-gate'] },
  });

  const result = await ctx.service.execute({
    machine: 'machine-a',
    mode: 'release',
    previewId: preview.previewId,
    reviewedTargets: [{ runId: 'run-gate', generation: 3 }],
  });

  assert.equal(result.outcome, 'complete');
  const record = ctx.runs.get('run-gate')!.park!;
  assert.equal(record.phase, 'parked');
  assert.equal(record.slotDisposition, 'freed');
  assert.ok(record.slotFreedAt, 'slotFreedAt records that ownership was actually released');
  // The park record survives with its slot binding; only slot ownership went away.
  assert.equal(record.slotId, 'slot-a');
  assert.equal(ctx.runs.get('run-gate')!.slotId, 'slot-a');
  assert.equal(ctx.slotOwners.get('slot-a'), null);
  // A gate park keeps the run at its gate: the pending decision stays answerable.
  assert.equal(ctx.runs.get('run-gate')!.status, 'human-gating');
  // Write-ahead ordering: the intent journal lands before the runner is stopped,
  // and the slot is freed only after the last resource stop.
  const journalIndex = ctx.calls.findIndex((call) => call.startsWith('journal-write:'));
  const stopIndex = ctx.calls.findIndex((call) => call.startsWith('stop-runner:'));
  const freeIndex = ctx.calls.findIndex((call) => call.startsWith('free-slot:'));
  const resourceIndex = ctx.calls.findIndex((call) => call.startsWith('stop-resource:'));
  assert.ok(journalIndex >= 0 && journalIndex < stopIndex);
  assert.ok(resourceIndex >= 0 && resourceIndex < freeIndex);
});

test('a gate park that cannot release slot ownership records a partial, not a freed slot', async () => {
  const ctx = harness([gateHeldRun('run-gate', 'slot-a')]);
  const preview = await ctx.service.preview({
    machine: 'machine-a',
    mode: 'release',
    selector: { kind: 'include', runIds: ['run-gate'] },
  });
  // Someone else claims the slot mid-park, after the preflight and before the
  // ownership release. Stealing it earlier would just stale the preview.
  const stopResource = ctx.deps.stopResource;
  ctx.deps.stopResource = async (slotId, resourceId) => {
    ctx.slotOwners.set('slot-a', 'run-other');
    return stopResource(slotId, resourceId);
  };

  const result = await ctx.service.execute({
    machine: 'machine-a',
    mode: 'release',
    previewId: preview.previewId,
    reviewedTargets: [{ runId: 'run-gate', generation: 3 }],
  });

  // No record reached `parked`, so the single-run batch reports failed.
  assert.equal(result.outcome, 'failed');
  const record = ctx.runs.get('run-gate')!.park!;
  assert.equal(record.phase, 'partial');
  assert.equal(record.slotFreedAt, undefined);
  assert.ok(record.errors.some((error) => error.action === 'slot.free'));
});

test('restore refuses a freed-slot park record with its own code', async () => {
  const run = gateHeldRun('run-gate', 'slot-a');
  run.park = {
    ...parkedRecord(run.id, 'slot-a'),
    mode: 'release',
    slotDisposition: 'freed',
    slotFreedAt: '2026-08-21T00:00:10.000Z',
    prePauseStatus: 'human-gating',
    recoveryHandle: recoveryHandle(run.id, 'slot-a'),
    residuals: { runner: 'stopped', resources: [] },
  };
  const ctx = harness([run]);
  ctx.slotOwners.set('slot-a', null);

  const preview = await ctx.service.restore({
    machine: 'machine-a',
    selector: { kind: 'include', runIds: ['run-gate'] },
  });

  const entry = preview.runs.find((item) => item.runId === 'run-gate')!;
  assert.equal(entry.eligibility.eligible, false);
  assert.equal(entry.eligibility.code, 'FREED_SLOT_RESTORE_UNSUPPORTED');
});

test('restart reconciliation keeps a freed-slot gate park parked without a paused run status', async () => {
  const run = gateHeldRun('run-gate', 'slot-a');
  run.park = {
    ...parkedRecord(run.id, 'slot-a'),
    mode: 'release',
    phase: 'resources-stopping',
    slotDisposition: 'freed',
    slotFreedAt: '2026-08-21T00:00:10.000Z',
    prePauseStatus: 'human-gating',
    recoveryHandle: recoveryHandle(run.id, 'slot-a'),
    resourceManifest: {
      capturedAt: '2026-08-21T00:00:00.000Z',
      resources: [
        {
          resourceId: 'browser-cdp',
          label: 'browser-cdp',
          type: 'browser',
          observedStatus: 'running',
          phase: 'stopped',
          capabilityLeaseIds: [],
        },
      ],
      capabilityLeases: [],
    },
    residuals: { runner: 'stopped', resources: [{ resourceId: 'browser-cdp', state: 'stopped' }] },
  };
  const ctx = harness([run]);
  ctx.slotOwners.set('slot-a', null);
  ctx.runnerStates.set('run-gate', 'stopped');

  const result = await ctx.service.reconcile();

  assert.deepEqual(result, { reconciled: 1, partial: 0 });
  assert.equal(ctx.runs.get('run-gate')!.park?.phase, 'parked');
  assert.equal(ctx.runs.get('run-gate')!.status, 'human-gating');
  assert.equal(ctx.slotOwners.get('slot-a'), null);
});

// ─── Round 2: workspace preservation and the journalled free transition ───

test('a gate park refuses when freeing the slot would discard uncommitted work', async () => {
  const ctx = harness([gateHeldRun('run-gate', 'slot-a')]);
  ctx.workspaces.set('slot-a', {
    branch: 'work/run-gate',
    headSha: 'sha-run-gate',
    dirtyPaths: [' M src/app.ts', '?? notes.md'],
  });

  const preview = await ctx.service.preview({
    machine: 'machine-a',
    mode: 'release',
    selector: { kind: 'include', runIds: ['run-gate'] },
  });

  const entry = preview.runs.find((run) => run.runId === 'run-gate')!;
  assert.equal(entry.eligibility.eligible, false);
  assert.equal(entry.eligibility.code, 'WORKSPACE_NOT_PRESERVABLE');
  assert.match(entry.eligibility.reason, /src\/app\.ts/);
  // Fail closed: nothing was detached and the runner was never stopped.
  assert.equal(
    ctx.calls.some((call) => call.startsWith('detach-workspace:')),
    false,
  );
  assert.equal(
    ctx.calls.some((call) => call.startsWith('stop-runner:')),
    false,
  );
});

test('a gate park detaches the parked branch before it releases the slot', async () => {
  const ctx = harness([gateHeldRun('run-gate', 'slot-a')]);
  const preview = await ctx.service.preview({
    machine: 'machine-a',
    mode: 'release',
    selector: { kind: 'include', runIds: ['run-gate'] },
  });

  await ctx.service.execute({
    machine: 'machine-a',
    mode: 'release',
    previewId: preview.previewId,
    reviewedTargets: [{ runId: 'run-gate', generation: 3 }],
  });

  const record = ctx.runs.get('run-gate')!.park!;
  assert.deepEqual(record.preservedWorkspace, {
    branch: 'work/run-gate',
    headSha: 'sha-run-gate',
    detachedAt: record.preservedWorkspace!.detachedAt,
  });
  // The branch is out of the working tree, so the next occupant's prepare
  // resets a detached HEAD instead of moving `work/run-gate`.
  assert.equal(ctx.workspaces.get('slot-a')!.branch, null);
  const detachIndex = ctx.calls.indexOf('detach-workspace:slot-a:work/run-gate');
  const freeIndex = ctx.calls.findIndex((call) => call.startsWith('free-slot:'));
  assert.ok(detachIndex >= 0, 'the parked branch was detached');
  assert.ok(detachIndex < freeIndex, 'the detach lands before slot ownership is released');
});

test('a gate park that cannot detach the parked branch never releases the slot', async () => {
  const ctx = harness([gateHeldRun('run-gate', 'slot-a')]);
  const preview = await ctx.service.preview({
    machine: 'machine-a',
    mode: 'release',
    selector: { kind: 'include', runIds: ['run-gate'] },
  });
  // The tree went dirty between the preview and the detach.
  const stopResource = ctx.deps.stopResource;
  ctx.deps.stopResource = async (slotId, resourceId) => {
    ctx.workspaces.set('slot-a', {
      branch: 'work/run-gate',
      headSha: 'sha-run-gate',
      dirtyPaths: [' M src/late.ts'],
    });
    return stopResource(slotId, resourceId);
  };

  await ctx.service.execute({
    machine: 'machine-a',
    mode: 'release',
    previewId: preview.previewId,
    reviewedTargets: [{ runId: 'run-gate', generation: 3 }],
  });

  const record = ctx.runs.get('run-gate')!.park!;
  assert.equal(record.phase, 'partial');
  assert.equal(record.slotFreedAt, undefined);
  assert.ok(record.errors.some((error) => error.action === 'workspace.detach'));
  // The slot still belongs to the parked run, so nothing can prepare over it.
  assert.equal(ctx.slotOwners.get('slot-a'), 'run-gate');
  assert.equal(
    ctx.calls.some((call) => call.startsWith('free-slot:')),
    false,
  );
});

test('the free transition is journalled around the slot release and cleared after it', async () => {
  const ctx = harness([gateHeldRun('run-gate', 'slot-a')]);
  const preview = await ctx.service.preview({
    machine: 'machine-a',
    mode: 'release',
    selector: { kind: 'include', runIds: ['run-gate'] },
  });

  await ctx.service.execute({
    machine: 'machine-a',
    mode: 'release',
    previewId: preview.previewId,
    reviewedTargets: [{ runId: 'run-gate', generation: 3 }],
  });

  const writeIndex = ctx.calls.findIndex((call) => call.startsWith('free-journal-write:'));
  const freeIndex = ctx.calls.findIndex((call) => call.startsWith('free-slot:'));
  const deleteIndex = ctx.calls.findIndex((call) => call.startsWith('free-journal-delete:'));
  assert.ok(writeIndex >= 0 && writeIndex < freeIndex, 'intent is durable before the release');
  assert.ok(freeIndex < deleteIndex, 'the journal outlives the release it covers');
  assert.equal(ctx.freeSlotJournals.size, 0, 'a completed transition leaves no journal');
});

test('recovery finishes a free transition whose slotFreedAt write was lost', async () => {
  const ctx = harness([gateHeldRun('run-gate', 'slot-a')]);
  const preview = await ctx.service.preview({
    machine: 'machine-a',
    mode: 'release',
    selector: { kind: 'include', runIds: ['run-gate'] },
  });
  // Crash window: the slot release landed, the `slotFreedAt` write did not, and
  // the journal survived. Dispatch has already handed the slot to another run.
  const freeSlotOwnership = ctx.deps.freeSlotOwnership;
  ctx.deps.freeSlotOwnership = async (slotId, runId) => {
    await freeSlotOwnership(slotId, runId);
    throw new Error('crashed before slotFreedAt was persisted');
  };
  await ctx.service
    .execute({
      machine: 'machine-a',
      mode: 'release',
      previewId: preview.previewId,
      reviewedTargets: [{ runId: 'run-gate', generation: 3 }],
    })
    .catch(() => undefined);
  ctx.deps.freeSlotOwnership = freeSlotOwnership;
  const crashed = ctx.runs.get('run-gate')!.park!;
  assert.equal(crashed.slotFreedAt, undefined, 'the crash left the record unfreed');
  assert.equal(ctx.freeSlotJournals.size, 1, 'the journal survived the crash');
  ctx.slotOwners.set('slot-a', 'run-successor');
  ctx.runnerStates.set('run-gate', 'stopped');

  await ctx.service.reconcile();

  const repaired = ctx.runs.get('run-gate')!.park!;
  assert.ok(repaired.slotFreedAt, 'recovery settled the interrupted free transition');
  assert.equal(repaired.phase, 'parked');
  // The successor keeps the slot; the parked record keeps its binding.
  assert.equal(ctx.slotOwners.get('slot-a'), 'run-successor');
  assert.equal(repaired.slotId, 'slot-a');
  assert.equal(ctx.runs.get('run-gate')!.slotId, 'slot-a');
  assert.equal(ctx.freeSlotJournals.size, 0, 'the settled journal is cleared');
});

test('a freed record reports its own recorded residuals, not the successor providers', async () => {
  const run = gateHeldRun('run-gate', 'slot-a');
  run.park = {
    ...parkedRecord(run.id, 'slot-a'),
    mode: 'release',
    phase: 'resources-stopping',
    slotDisposition: 'freed',
    slotFreedAt: '2026-08-21T00:00:10.000Z',
    prePauseStatus: 'human-gating',
    recoveryHandle: recoveryHandle(run.id, 'slot-a'),
    resourceManifest: {
      capturedAt: '2026-08-21T00:00:00.000Z',
      resources: [
        {
          resourceId: 'browser-cdp',
          label: 'browser-cdp',
          type: 'browser',
          observedStatus: 'running',
          phase: 'stopped',
          capabilityLeaseIds: [],
        },
      ],
      capabilityLeases: [],
    },
    residuals: { runner: 'stopped', resources: [{ resourceId: 'browser-cdp', state: 'stopped' }] },
  };
  const ctx = harness([run]);
  ctx.slotOwners.set('slot-a', 'run-successor');
  // The successor booted the same provider on the slot it now owns, and its
  // runner is live. Probing the slot would read both as the parked run's.
  ctx.runnerStates.set('run-gate', 'running');

  await ctx.service.reconcile();

  const record = ctx.runs.get('run-gate')!.park!;
  assert.equal(record.phase, 'parked', 'the successor providers did not reopen the parked record');
  assert.equal(record.residuals.runner, 'stopped');
  assert.deepEqual(record.residuals.resources, [
    {
      resourceId: 'browser-cdp',
      state: 'stopped',
      detail: 'observed before the slot was freed',
    },
  ]);
  // Nothing on the successor's slot was probed for this record.
  assert.equal(
    ctx.calls.some((call) => call === 'observe:slot-a'),
    false,
  );
});

test('a park that detached the branch is never discarded as zero-effect', async () => {
  const run = gateHeldRun('run-gate', 'slot-a');
  run.park = {
    ...parkedRecord(run.id, 'slot-a'),
    mode: 'release',
    phase: 'partial',
    slotDisposition: 'freed',
    prePauseStatus: 'human-gating',
    preservedWorkspace: {
      branch: 'work/run-gate',
      headSha: 'sha-run-gate',
      detachedAt: '2026-08-21T00:00:09.000Z',
    },
    recoveryHandle: recoveryHandle(run.id, 'slot-a'),
    residuals: { runner: 'running', resources: [] },
  };
  const ctx = harness([run]);

  await ctx.service.reconcile();

  // A gate park preserves the run status, so the status check says nothing.
  // The detached branch is the effect that must keep the record alive — losing
  // it would leave a detached HEAD with no note of which branch to restore.
  const record = ctx.runs.get('run-gate')!.park;
  assert.ok(record, 'the record survived reconciliation');
  assert.equal(record!.preservedWorkspace?.branch, 'work/run-gate');
});

test('the detach timestamp records the fact, so a re-drive does not detach twice', async () => {
  const ctx = harness([gateHeldRun('run-gate', 'slot-a')]);
  const preview = await ctx.service.preview({
    machine: 'machine-a',
    mode: 'release',
    selector: { kind: 'include', runIds: ['run-gate'] },
  });

  await ctx.service.execute({
    machine: 'machine-a',
    mode: 'release',
    previewId: preview.previewId,
    reviewedTargets: [{ runId: 'run-gate', generation: 3 }],
  });

  const record = ctx.runs.get('run-gate')!.park!;
  assert.ok(record.preservedWorkspace?.detachedAt, 'the landed detach is recorded');
  const detachCalls = ctx.calls.filter((call) => call.startsWith('detach-workspace:')).length;
  assert.equal(detachCalls, 1);

  // Re-driving the settled transition is a no-op on the working tree.
  await ctx.service.reconcile();
  assert.equal(
    ctx.calls.filter((call) => call.startsWith('detach-workspace:')).length,
    detachCalls,
  );
});

// ─── ADR-054 free-slot: a park that changes nothing must not strand the run ───

test('a park that failed before touching the slot stays fenced but becomes restorable', async () => {
  const ctx = harness([gateHeldRun('run-gate', 'slot-a')]);
  const preview = await ctx.service.preview({
    machine: 'machine-a',
    mode: 'release',
    selector: { kind: 'include', runIds: ['run-gate'] },
  });
  // The worker is live during preview and only stops later, so the tree can go
  // dirty in between. The detach then refuses and nothing at all has landed.
  const stopResource = ctx.deps.stopResource;
  ctx.deps.stopResource = async (slotId, resourceId) => {
    ctx.workspaces.set('slot-a', {
      branch: 'work/run-gate',
      headSha: 'sha-run-gate',
      dirtyPaths: [' M src/late.ts'],
    });
    return stopResource(slotId, resourceId);
  };
  await ctx.service.execute({
    machine: 'machine-a',
    mode: 'release',
    previewId: preview.previewId,
    reviewedTargets: [{ runId: 'run-gate', generation: 3 }],
  });

  const parked = ctx.runs.get('run-gate')!;
  assert.equal(parked.park!.phase, 'partial');
  assert.equal(parked.park!.slotFreedAt, undefined);
  assert.equal(parked.park!.preservedWorkspace?.detachedAt, undefined);
  // The failure is on the record, so the operator can see why.
  assert.ok(parked.park!.errors.some((error) => error.action === 'workspace.detach'));

  // The park stops the runner BEFORE it touches the slot, so by the time the
  // detach refused the worker was already dead. The fence therefore stays up:
  // answering a publication gate with a stopped worker is the silent version of
  // the strand this contract exists to prevent.
  assert.equal(parked.park!.residuals.runner, 'stopped');
  assert.equal(isGateParkInFlightOrFreed(parked), true);

  // Restore is the exit, and it must be admitted. A gate park preserves the
  // run's status by design, so the ordinary `paused` precondition would refuse
  // every one of them and leave cancellation as the only way out.
  const restorePreview = await ctx.service.restore({
    machine: 'machine-a',
    selector: { kind: 'include', runIds: ['run-gate'] },
  });
  const verdict = restorePreview.runs[0]?.eligibility;
  assert.notEqual(verdict?.code, 'FREED_SLOT_RESTORE_UNSUPPORTED');
  assert.notEqual(verdict?.code, 'RUN_NOT_PAUSED', 'a gate park never sets paused');
});

test('a detach that landed is rolled back when the release fails, so the run is not stranded', async () => {
  const ctx = harness([gateHeldRun('run-gate', 'slot-a')]);
  const preview = await ctx.service.preview({
    machine: 'machine-a',
    mode: 'release',
    selector: { kind: 'include', runIds: ['run-gate'] },
  });
  // The detach succeeds; a rival fences the row so the ownership CAS refuses.
  ctx.deps.freeSlotOwnership = async (slotId, runId) => {
    ctx.calls.push(`free-slot:${slotId}:${runId}`);
    return false;
  };

  await ctx.service.execute({
    machine: 'machine-a',
    mode: 'release',
    previewId: preview.previewId,
    reviewedTargets: [{ runId: 'run-gate', generation: 3 }],
  });

  const parked = ctx.runs.get('run-gate')!;
  assert.equal(parked.park!.phase, 'partial');
  assert.equal(parked.park!.slotFreedAt, undefined);
  // The branch went back into the working tree at the tip it was detached from.
  assert.ok(ctx.calls.includes('reattach-workspace:slot-a:work/run-gate'));
  assert.equal(ctx.workspaces.get('slot-a')?.branch, 'work/run-gate');
  assert.equal(parked.park!.preservedWorkspace?.detachedAt, undefined);
  // The workspace is back, but the runner the park stopped is still stopped, so
  // the run stays fenced until a restore reloads it.
  assert.equal(isGateParkInFlightOrFreed(parked), true);
  // The write-ahead marker is gone, so the next reconcile cannot re-drive this
  // abandoned transition and free the slot of a run that has since resumed.
  assert.equal(ctx.freeSlotJournals.size, 0, 'the abandoned intent is durably dropped');
});

test('a detach that cannot be rolled back keeps the fence up rather than lying', async () => {
  const ctx = harness([gateHeldRun('run-gate', 'slot-a')]);
  const preview = await ctx.service.preview({
    machine: 'machine-a',
    mode: 'release',
    selector: { kind: 'include', runIds: ['run-gate'] },
  });
  ctx.deps.freeSlotOwnership = async () => false;
  ctx.deps.reattachParkedWorkspace = async () => {
    throw new Error('branch moved under us');
  };

  await ctx.service.execute({
    machine: 'machine-a',
    mode: 'release',
    previewId: preview.previewId,
    reviewedTargets: [{ runId: 'run-gate', generation: 3 }],
  });

  const parked = ctx.runs.get('run-gate')!;
  assert.ok(parked.park!.preservedWorkspace?.detachedAt);
  assert.ok(parked.park!.errors.some((error) => error.action === 'workspace.reattach'));
  // One real effect is still outstanding, so the run stays fenced.
  assert.equal(isGateParkInFlightOrFreed(parked), true);
});

test('recovery concludes a release landed only when the slot row proves it', async () => {
  const ctx = harness([gateHeldRun('run-gate', 'slot-a')]);
  const preview = await ctx.service.preview({
    machine: 'machine-a',
    mode: 'release',
    selector: { kind: 'include', runIds: ['run-gate'] },
  });
  // Crash shape: the detach landed and the release did not, and the row is
  // fenced mid-teardown — still ours, so the CAS refuses for a reason that is
  // NOT a completed release.
  ctx.deps.freeSlotOwnership = async () => false;
  await ctx.service.execute({
    machine: 'machine-a',
    mode: 'release',
    previewId: preview.previewId,
    reviewedTargets: [{ runId: 'run-gate', generation: 3 }],
  });
  // Re-arm the journal and put the record back mid-transition.
  await ctx.deps.writeIntentJournal(
    'free-slot',
    [{ ...ctx.runs.get('run-gate')!.park!, phase: 'parked' }],
    'run-gate',
  );
  ctx.runs.get('run-gate')!.park = {
    ...ctx.runs.get('run-gate')!.park!,
    // An UNSETTLED phase, so reconcile actually re-observes this record.
    phase: 'resources-stopping',
    slotFreedAt: undefined,
  };
  ctx.slotOwners.set('slot-a', 'run-gate');
  ctx.slotLifecycles.set('slot-a', 'busy');

  await ctx.service.reconcile();

  // The row still names this run, so "not ours" was never true: concluding
  // freed here would publish a release that never happened.
  assert.equal(ctx.runs.get('run-gate')!.park!.slotFreedAt, undefined);
  assert.equal(ctx.runs.get('run-gate')!.park!.phase, 'partial');
});

test('recovery finishes the transition when the row shows a rival already owns the slot', async () => {
  const ctx = harness([gateHeldRun('run-gate', 'slot-a')]);
  const preview = await ctx.service.preview({
    machine: 'machine-a',
    mode: 'release',
    selector: { kind: 'include', runIds: ['run-gate'] },
  });
  ctx.deps.freeSlotOwnership = async () => false;
  await ctx.service.execute({
    machine: 'machine-a',
    mode: 'release',
    previewId: preview.previewId,
    reviewedTargets: [{ runId: 'run-gate', generation: 3 }],
  });
  await ctx.deps.writeIntentJournal(
    'free-slot',
    [{ ...ctx.runs.get('run-gate')!.park!, phase: 'parked' }],
    'run-gate',
  );
  ctx.runs.get('run-gate')!.park = {
    ...ctx.runs.get('run-gate')!.park!,
    // An UNSETTLED phase, so reconcile actually re-observes this record.
    phase: 'resources-stopping',
    slotFreedAt: undefined,
  };
  // The release DID land before the crash and dispatch handed the slot on.
  ctx.slotOwners.set('slot-a', 'successor-run');
  ctx.slotLifecycles.set('slot-a', 'busy');

  await ctx.service.reconcile();

  assert.ok(ctx.runs.get('run-gate')!.park!.slotFreedAt);
});

test('a park stops rather than freeing a slot whose run went terminal underneath it', async () => {
  const ctx = harness([gateHeldRun('run-gate', 'slot-a')]);
  const preview = await ctx.service.preview({
    machine: 'machine-a',
    mode: 'release',
    selector: { kind: 'include', runIds: ['run-gate'] },
  });
  // A cancel racing the park terminalizes the run while resources stop. Cancel
  // owns the slot cleanup from here; two writers on one slot row is the bug.
  const stopResource = ctx.deps.stopResource;
  ctx.deps.stopResource = async (slotId, resourceId) => {
    ctx.runs.get('run-gate')!.status = 'cancelled';
    return stopResource(slotId, resourceId);
  };

  await ctx.service.execute({
    machine: 'machine-a',
    mode: 'release',
    previewId: preview.previewId,
    reviewedTargets: [{ runId: 'run-gate', generation: 3 }],
  });

  assert.equal(ctx.runs.get('run-gate')!.park!.slotFreedAt, undefined);
  assert.equal(
    ctx.calls.some((call) => call.startsWith('detach-workspace:')),
    false,
    'a terminal run must not have its workspace detached',
  );
  assert.equal(
    ctx.calls.some((call) => call.startsWith('free-slot:')),
    false,
  );
});

test('one batch member completing does not erase a failed sibling pending repair', async () => {
  const ctx = harness([gateHeldRun('run-a', 'slot-a'), gateHeldRun('run-b', 'slot-b')]);
  const preview = await ctx.service.preview({
    machine: 'machine-a',
    mode: 'release',
    selector: { kind: 'include', runIds: ['run-a', 'run-b'] },
  });
  // run-a CRASHES mid-transition, so its write-ahead marker must survive for the
  // next reconcile; run-b completes and deletes its own. Both share one
  // operationId, which is exactly why an unscoped journal file cannot hold both:
  // run-b's cleanup would take run-a's pending repair with it.
  ctx.deps.freeSlotOwnership = async (slotId, runId) => {
    ctx.calls.push(`free-slot:${slotId}:${runId}`);
    if (runId === 'run-a') throw new Error('crashed before slotFreedAt was persisted');
    ctx.slotOwners.set(slotId, null);
    return true;
  };

  await ctx.service
    .execute({
      machine: 'machine-a',
      mode: 'release',
      previewId: preview.previewId,
      reviewedTargets: [
        { runId: 'run-a', generation: 3 },
        { runId: 'run-b', generation: 3 },
      ],
    })
    .catch(() => undefined);

  assert.equal(ctx.runs.get('run-b')!.park!.slotFreedAt !== undefined, true);
  assert.equal(ctx.runs.get('run-a')!.park!.slotFreedAt, undefined);
  // run-b's completion deletes ITS journal. run-a's unfinished intent must
  // survive, or the crash window it covers is silently lost.
  assert.equal(
    [...ctx.freeSlotJournals].some((key) => key.endsWith(':run-a')),
    true,
    'the failed member keeps its own pending repair',
  );
  assert.equal(
    [...ctx.freeSlotJournals].some((key) => key.endsWith(':run-b')),
    false,
    'the completed member cleans up only its own intent',
  );
});

test('rollback refuses to touch a checkout a successor already owns', async () => {
  const ctx = harness([gateHeldRun('run-gate', 'slot-a')]);
  const preview = await ctx.service.preview({
    machine: 'machine-a',
    mode: 'release',
    selector: { kind: 'include', runIds: ['run-gate'] },
  });
  // The release is refused because a rival already claimed the row. Reattaching
  // would run `git checkout <our branch>` inside the successor's working tree,
  // on top of whatever their prepare just laid down.
  ctx.deps.freeSlotOwnership = async (slotId, runId) => {
    ctx.calls.push(`free-slot:${slotId}:${runId}`);
    ctx.slotOwners.set(slotId, 'run-successor');
    return false;
  };

  await ctx.service.execute({
    machine: 'machine-a',
    mode: 'release',
    previewId: preview.previewId,
    reviewedTargets: [{ runId: 'run-gate', generation: 3 }],
  });

  assert.equal(
    ctx.calls.some((call) => call.startsWith('reattach-workspace:')),
    false,
    'a slot owned by someone else is not ours to check out',
  );
  const parked = ctx.runs.get('run-gate')!.park!;
  assert.ok(parked.errors.some((error) => error.action === 'workspace.reattach'));
  // The detach is still on the record, so the fence stays up and the outstanding
  // effect is visible rather than silently assumed reversed.
  assert.ok(parked.preservedWorkspace?.detachedAt);
  assert.equal(isGateParkInFlightOrFreed(ctx.runs.get('run-gate')!), true);
});

test('rollback refuses when the workspace moved off the commit the park detached', async () => {
  const ctx = harness([gateHeldRun('run-gate', 'slot-a')]);
  const preview = await ctx.service.preview({
    machine: 'machine-a',
    mode: 'release',
    selector: { kind: 'include', runIds: ['run-gate'] },
  });
  ctx.deps.freeSlotOwnership = async (slotId, runId) => {
    ctx.calls.push(`free-slot:${slotId}:${runId}`);
    // Ownership is still ours, but another writer moved the tree.
    ctx.workspaces.set('slot-a', {
      branch: null,
      headSha: 'sha-someone-else',
      dirtyPaths: [],
    });
    return false;
  };

  await ctx.service.execute({
    machine: 'machine-a',
    mode: 'release',
    previewId: preview.previewId,
    reviewedTargets: [{ runId: 'run-gate', generation: 3 }],
  });

  assert.equal(
    ctx.calls.some((call) => call.startsWith('reattach-workspace:')),
    false,
    'a checkout onto an unknown tip would be guessing whose work is on top',
  );
  const parked = ctx.runs.get('run-gate')!.park!;
  assert.ok(
    parked.errors.some(
      (error) => error.action === 'workspace.reattach' && /moved to/.test(error.message ?? ''),
    ),
  );
});

test('a fenced partial gate park restores end to end and its gate is answerable again', async () => {
  const ctx = harness([gateHeldRun('run-gate', 'slot-a')]);
  const preview = await ctx.service.preview({
    machine: 'machine-a',
    mode: 'release',
    selector: { kind: 'include', runIds: ['run-gate'] },
  });
  // The tree goes dirty between preview and detach, so the park refuses after
  // it has already stopped the worker. This is the state restore is the
  // advertised exit from.
  const stopResource = ctx.deps.stopResource;
  ctx.deps.stopResource = async (slotId, resourceId) => {
    ctx.workspaces.set('slot-a', {
      branch: 'work/run-gate',
      headSha: 'sha-run-gate',
      dirtyPaths: [' M src/late.ts'],
    });
    return stopResource(slotId, resourceId);
  };
  await ctx.service.execute({
    machine: 'machine-a',
    mode: 'release',
    previewId: preview.previewId,
    reviewedTargets: [{ runId: 'run-gate', generation: 3 }],
  });
  ctx.deps.stopResource = stopResource;

  const fenced = ctx.runs.get('run-gate')!;
  assert.equal(fenced.park!.phase, 'partial');
  assert.equal(fenced.status, 'human-gating', 'a gate park never moves the run to paused');
  assert.equal(isGateParkInFlightOrFreed(fenced), true, 'fenced while the worker is stopped');

  const restorePreview = await ctx.service.restore({
    machine: 'machine-a',
    selector: { kind: 'include', runIds: ['run-gate'] },
  });
  assert.equal(
    restorePreview.runs[0]?.eligibility.eligible,
    true,
    JSON.stringify(restorePreview.runs[0]?.eligibility),
  );

  const restored = await ctx.service.restore({
    machine: 'machine-a',
    selector: { kind: 'include', runIds: ['run-gate'] },
    execute: true,
    previewId: restorePreview.previewId,
    reviewedTargets: [{ runId: 'run-gate', generation: 3 }],
    operationId: 'gate-park-restore',
  });

  // Before this branch existed the restore reloaded the worker and THEN threw
  // at run.resume, reporting not-ok for a restore that had actually happened.
  assert.equal(restored.ok, true, JSON.stringify(restored.records?.[0]?.errors ?? []));
  const after = ctx.runs.get('run-gate')!;
  assert.equal(after.park!.phase, 'restored');
  assert.equal(after.status, 'human-gating', 'the gate status the park preserved survives restore');
  assert.equal(ctx.runnerStates.get('run-gate'), 'running', 'the worker came back');
  // The whole point: the operator can answer the gate again.
  assert.equal(isGateParkInFlightOrFreed(after), false);
  // Nothing was re-driven — the gate loop was never cancelled, so a generation
  // bump would only have made a live loop bail.
  assert.equal(after.engineState?.generation, 3);
});

test('restore refuses to report success while the parked branch is still detached', async () => {
  const ctx = harness([gateHeldRun('run-gate', 'slot-a')]);
  const preview = await ctx.service.preview({
    machine: 'machine-a',
    mode: 'release',
    selector: { kind: 'include', runIds: ['run-gate'] },
  });
  // Release refused AND the rollback fails, so the park settles partial with
  // the branch still out of the working tree.
  ctx.deps.freeSlotOwnership = async () => false;
  ctx.deps.reattachParkedWorkspace = async () => {
    throw new Error('branch moved under us');
  };
  await ctx.service.execute({
    machine: 'machine-a',
    mode: 'release',
    previewId: preview.previewId,
    reviewedTargets: [{ runId: 'run-gate', generation: 3 }],
  });
  assert.ok(ctx.runs.get('run-gate')!.park!.preservedWorkspace?.detachedAt);

  const restorePreview = await ctx.service.restore({
    machine: 'machine-a',
    selector: { kind: 'include', runIds: ['run-gate'] },
  });
  const restored = await ctx.service.restore({
    machine: 'machine-a',
    selector: { kind: 'include', runIds: ['run-gate'] },
    execute: true,
    previewId: restorePreview.previewId,
    reviewedTargets: [{ runId: 'run-gate', generation: 3 }],
    operationId: 'gate-park-restore-detached',
  });

  // Reporting ok here would tell the operator the run is back while its
  // workspace has no branch checked out.
  assert.equal(restored.ok, false);
  const after = ctx.runs.get('run-gate')!;
  assert.equal(after.park!.phase, 'partial');
  assert.ok(after.park!.errors.some((error) => error.action === 'workspace.reattach'));
  // The detach is still outstanding, so the fence stays up.
  assert.ok(after.park!.preservedWorkspace?.detachedAt);
  assert.equal(isGateParkInFlightOrFreed(after), true);
});

test('restore retries the reattach and completes once the branch is back', async () => {
  const ctx = harness([gateHeldRun('run-gate', 'slot-a')]);
  const preview = await ctx.service.preview({
    machine: 'machine-a',
    mode: 'release',
    selector: { kind: 'include', runIds: ['run-gate'] },
  });
  ctx.deps.freeSlotOwnership = async () => false;
  const reattach = ctx.deps.reattachParkedWorkspace;
  let attempts = 0;
  ctx.deps.reattachParkedWorkspace = async (run, workspace) => {
    attempts += 1;
    // Fails during the park's own rollback, succeeds when restore retries it.
    if (attempts === 1) throw new Error('transient checkout failure');
    return reattach(run, workspace);
  };
  await ctx.service.execute({
    machine: 'machine-a',
    mode: 'release',
    previewId: preview.previewId,
    reviewedTargets: [{ runId: 'run-gate', generation: 3 }],
  });
  assert.ok(ctx.runs.get('run-gate')!.park!.preservedWorkspace?.detachedAt);

  const restorePreview = await ctx.service.restore({
    machine: 'machine-a',
    selector: { kind: 'include', runIds: ['run-gate'] },
  });
  const restored = await ctx.service.restore({
    machine: 'machine-a',
    selector: { kind: 'include', runIds: ['run-gate'] },
    execute: true,
    previewId: restorePreview.previewId,
    reviewedTargets: [{ runId: 'run-gate', generation: 3 }],
    operationId: 'gate-park-restore-retry',
  });

  assert.equal(restored.ok, true, JSON.stringify(ctx.runs.get('run-gate')!.park!.errors));
  const after = ctx.runs.get('run-gate')!;
  assert.equal(after.park!.phase, 'restored');
  assert.equal(after.park!.preservedWorkspace?.detachedAt, undefined);
  assert.equal(ctx.workspaces.get('slot-a')?.branch, 'work/run-gate');
  assert.equal(isGateParkInFlightOrFreed(after), false);
});

test('a reattach failure leaves the generation untouched, so the restore can be retried', async () => {
  const ctx = harness([gateHeldRun('run-gate', 'slot-a')]);
  const preview = await ctx.service.preview({
    machine: 'machine-a',
    mode: 'release',
    selector: { kind: 'include', runIds: ['run-gate'] },
  });
  ctx.deps.freeSlotOwnership = async () => false;
  let allowReattach = false;
  ctx.deps.reattachParkedWorkspace = async () => {
    if (!allowReattach) throw new Error('checkout busy');
  };
  await ctx.service.execute({
    machine: 'machine-a',
    mode: 'release',
    previewId: preview.previewId,
    reviewedTargets: [{ runId: 'run-gate', generation: 3 }],
  });
  assert.ok(ctx.runs.get('run-gate')!.park!.preservedWorkspace?.detachedAt);

  // First restore: the reattach still fails. It must fail BEFORE anything that
  // advances the generation, or the record is left describing a generation that
  // no longer exists and every later preview rejects GENERATION_CHANGED.
  const firstPreview = await ctx.service.restore({
    machine: 'machine-a',
    selector: { kind: 'include', runIds: ['run-gate'] },
  });
  const firstAttempt = await ctx.service.restore({
    machine: 'machine-a',
    selector: { kind: 'include', runIds: ['run-gate'] },
    execute: true,
    previewId: firstPreview.previewId,
    reviewedTargets: [{ runId: 'run-gate', generation: 3 }],
    operationId: 'restore-attempt-1',
  });
  assert.equal(firstAttempt.ok, false);
  const afterFailure = ctx.runs.get('run-gate')!;
  assert.equal(afterFailure.park!.phase, 'partial');
  assert.equal(
    afterFailure.park!.generation,
    afterFailure.engineState?.generation ?? 3,
    'the record must still describe the run generation that exists',
  );

  // Second restore once the checkout problem clears: it must be admitted.
  allowReattach = true;
  ctx.deps.reattachParkedWorkspace = async (run, workspace) => {
    const current = ctx.workspaces.get(run.slotId!)!;
    ctx.workspaces.set(run.slotId!, { ...current, branch: workspace.branch });
  };
  const retryPreview = await ctx.service.restore({
    machine: 'machine-a',
    selector: { kind: 'include', runIds: ['run-gate'] },
  });
  assert.notEqual(
    retryPreview.runs[0]?.eligibility.code,
    'GENERATION_CHANGED',
    'a failed restore must not make the record permanently unretryable',
  );
  const retry = await ctx.service.restore({
    machine: 'machine-a',
    selector: { kind: 'include', runIds: ['run-gate'] },
    execute: true,
    previewId: retryPreview.previewId,
    reviewedTargets: [
      { runId: 'run-gate', generation: ctx.runs.get('run-gate')!.engineState?.generation ?? 3 },
    ],
    operationId: 'restore-attempt-2',
  });
  assert.equal(retry.ok, true, JSON.stringify(ctx.runs.get('run-gate')!.park!.errors));
  assert.equal(ctx.runs.get('run-gate')!.park!.phase, 'restored');
});

test('a replay that advances the generation then fails still leaves the record retryable', async () => {
  const ctx = harness([gateHeldRun('run-gate', 'slot-a')]);
  const preview = await ctx.service.preview({
    machine: 'machine-a',
    mode: 'release',
    selector: { kind: 'include', runIds: ['run-gate'] },
  });
  ctx.deps.freeSlotOwnership = async () => false;
  await ctx.service.execute({
    machine: 'machine-a',
    mode: 'release',
    previewId: preview.previewId,
    reviewedTargets: [{ runId: 'run-gate', generation: 3 }],
  });

  // The resume advances the generation (as a gate replay does) and then fails
  // its acknowledgement check. This is the one failure path that can follow an
  // advance, since the reattach is verified before the resume.
  ctx.deps.resumeRun = async (runId) => {
    const run = ctx.runs.get(runId)!;
    run.engineState = { ...run.engineState, generation: 9 };
    throw new Error('acknowledgement did not match');
  };

  const restorePreview = await ctx.service.restore({
    machine: 'machine-a',
    selector: { kind: 'include', runIds: ['run-gate'] },
  });
  const attempt = await ctx.service.restore({
    machine: 'machine-a',
    selector: { kind: 'include', runIds: ['run-gate'] },
    execute: true,
    previewId: restorePreview.previewId,
    reviewedTargets: [{ runId: 'run-gate', generation: 3 }],
    operationId: 'restore-advance-then-fail',
  });

  assert.equal(attempt.ok, false);
  const after = ctx.runs.get('run-gate')!;
  assert.equal(after.park!.phase, 'partial');
  // Left at the pre-replay generation, the preview would reject
  // GENERATION_CHANGED and the record could never be retried.
  assert.equal(after.park!.generation, 9);
  const retryPreview = await ctx.service.restore({
    machine: 'machine-a',
    selector: { kind: 'include', runIds: ['run-gate'] },
  });
  assert.notEqual(retryPreview.runs[0]?.eligibility.code, 'GENERATION_CHANGED');
});

test('a persistence failure after a replay still leaves the record retryable', async () => {
  const ctx = harness([gateHeldRun('run-gate', 'slot-a')]);
  const preview = await ctx.service.preview({
    machine: 'machine-a',
    mode: 'release',
    selector: { kind: 'include', runIds: ['run-gate'] },
  });
  ctx.deps.freeSlotOwnership = async () => false;
  await ctx.service.execute({
    machine: 'machine-a',
    mode: 'release',
    previewId: preview.previewId,
    reviewedTargets: [{ runId: 'run-gate', generation: 3 }],
  });

  // The resume replays the gate, which takes ownership and ADVANCES the run
  // generation. It succeeds.
  ctx.deps.resumeRun = async (runId) => {
    const run = ctx.runs.get(runId)!;
    const previousGeneration = run.engineState?.generation ?? 0;
    run.engineState = { ...run.engineState, generation: 9 };
    return {
      run,
      previousGeneration,
      generation: 9,
      stepName: run.park!.prePauseCurrentStep!.name,
      status: run.status,
      acknowledgedAt: '2026-08-21T00:00:31.000Z',
      gateParkReplayed: true as const,
    };
  };
  // Then the settle's own persistence throws. This is OUTSIDE the resume's
  // catch, so it escapes restoreOne and lands in settleUnexpectedFailure — the
  // path that rebuilds the record from scratch.
  const persistRun = ctx.deps.persistRun;
  ctx.deps.persistRun = async (run, reason) => {
    if (reason === 'machine-pause-restored') throw new Error('disk full');
    return persistRun(run, reason);
  };

  const restorePreview = await ctx.service.restore({
    machine: 'machine-a',
    selector: { kind: 'include', runIds: ['run-gate'] },
  });
  const attempt = await ctx.service.restore({
    machine: 'machine-a',
    selector: { kind: 'include', runIds: ['run-gate'] },
    execute: true,
    previewId: restorePreview.previewId,
    reviewedTargets: [{ runId: 'run-gate', generation: 3 }],
    operationId: 'restore-persist-fails',
  });

  assert.equal(attempt.ok, false);
  const after = ctx.runs.get('run-gate')!;
  assert.equal(after.park!.phase, 'partial');
  assert.equal(after.engineState?.generation, 9, 'the replay advanced the run');
  // Left at the pre-replay generation, both the restore preview and the execute
  // preflight refuse every retry forever.
  assert.equal(
    after.park!.generation,
    9,
    'the record must describe the generation the run actually has',
  );
  assert.ok(
    after.park!.errors.some((error) => error.code === 'UNEXPECTED_EFFECT_FAILURE'),
    'the failure itself is on the record for the operator to read',
  );

  // And the retry is admitted rather than rejected as changed.
  ctx.deps.persistRun = persistRun;
  const retryPreview = await ctx.service.restore({
    machine: 'machine-a',
    selector: { kind: 'include', runIds: ['run-gate'] },
  });
  assert.notEqual(retryPreview.runs[0]?.eligibility.code, 'GENERATION_CHANGED');
  assert.equal(
    retryPreview.runs[0]?.eligibility.eligible,
    true,
    JSON.stringify(retryPreview.runs[0]?.eligibility),
  );
});

test('residual observation never throws, so a probe failure cannot erase a settled result', async () => {
  const ctx = harness([gateHeldRun('run-gate', 'slot-a')]);
  const preview = await ctx.service.preview({
    machine: 'machine-a',
    mode: 'release',
    selector: { kind: 'include', runIds: ['run-gate'] },
  });
  await ctx.service.execute({
    machine: 'machine-a',
    mode: 'release',
    previewId: preview.previewId,
    reviewedTargets: [{ runId: 'run-gate', generation: 3 }],
  });

  // Both probes are unreachable. Residual collection runs on settlement paths,
  // after an operation has already had its effects, so it must report what it
  // could observe rather than throwing and erasing that durable result.
  ctx.deps.runnerRunning = async () => {
    throw new Error('node unreachable');
  };
  ctx.deps.observeResources = async () => {
    throw new Error('node unreachable');
  };
  ctx.runs.get('run-gate')!.park = {
    ...ctx.runs.get('run-gate')!.park!,
    // An UNSETTLED phase, so reconcile actually re-observes this record.
    phase: 'resources-stopping',
    slotFreedAt: undefined,
    recoveryHandle: {
      sessionId: 'session-run-gate',
      sessionPath: '/sessions/run-gate.jsonl',
      runnerId: 'claude',
      target: { session: 'slot-a', window: '0', pane: '0' },
      model: 'sonnet',
      capturedAt: '2026-08-21T00:00:00.000Z',
    } as never,
  };

  // Reconcile observes residuals for every unsettled record on the machine.
  await ctx.service.reconcile();

  const after = ctx.runs.get('run-gate')!.park!;
  // What could not be observed is reported as unknown rather than guessed, and
  // the reconcile completed instead of throwing.
  assert.equal(after.residuals.runner, 'unknown');
  for (const resource of after.residuals.resources) {
    assert.equal(resource.state, 'unknown');
  }
});

test('a pause-path failure never adopts a foreign generation bump', async () => {
  const ctx = harness([gateHeldRun('run-gate', 'slot-a')]);
  const preview = await ctx.service.preview({
    machine: 'machine-a',
    mode: 'release',
    selector: { kind: 'include', runIds: ['run-gate'] },
  });
  // A pause never advances the run generation itself, so a bump seen here is
  // FOREIGN — another actor moved the run while it parked. Adopting it would
  // defeat the GENERATION_CHANGED check for this record's later restore, which
  // is exactly the drift that check exists to catch.
  const persistRun = ctx.deps.persistRun;
  ctx.deps.persistRun = async (run, reason) => {
    if (reason === 'machine-pause-parked') {
      const live = ctx.runs.get(run.id)!;
      live.engineState = { ...live.engineState, generation: 42 };
      throw new Error('disk full');
    }
    return persistRun(run, reason);
  };

  await ctx.service.execute({
    machine: 'machine-a',
    mode: 'release',
    previewId: preview.previewId,
    reviewedTargets: [{ runId: 'run-gate', generation: 3 }],
  });

  const after = ctx.runs.get('run-gate')!;
  assert.equal(after.engineState?.generation, 42, 'the foreign bump landed on the run');
  assert.equal(
    after.park!.generation,
    3,
    'the record keeps the generation it parked at, so the drift is still visible',
  );
});

/** Catalog status whose single provider declares the affected resources it touches. */
function statusWithAffectedResources(
  runId: string,
  affectedResources: RuntimeCapabilityCatalogEntry['affectedResources'],
  options: { foreignRunId?: string; slotActions?: boolean; leases?: boolean } = {},
): RuntimeCapabilityStatusResult {
  const status = capabilityStatusFor(
    runId,
    options.foreignRunId ? { foreignRunId: options.foreignRunId } : {},
  );
  if (options.slotActions) {
    status.catalog[0]!.actions = {
      acquire: { kind: 'slot-action', actionId: 'browser-start' },
      health: { kind: 'slot-action', actionId: 'browser-health' },
      release: { kind: 'slot-action', actionId: 'browser-stop' },
    };
  }
  status.catalog[0]!.affectedResources = affectedResources;
  if (options.leases === false) status.leases = [];
  return status;
}

test('a slot-action capability that declares its affected resources is eligible to park', async () => {
  const ctx = harness([activeRun('run-a', 'slot-a')]);
  const status = statusWithAffectedResources(
    'run-a',
    [{ resourceId: 'browser-cdp', ownership: 'capability', releaseEffect: 'stop' }],
    { slotActions: true },
  );
  ctx.deps.capabilityStatus = async () => structuredClone(status);
  const preview = await ctx.service.preview({
    machine: 'machine-a',
    mode: 'release',
    selector: { kind: 'all' },
  });
  assert.equal(preview.runs[0]?.eligibility.eligible, true);
  assert.equal(preview.runs[0]?.eligibility.code, 'ELIGIBLE_RELEASE_PAUSE');
  assert.equal(
    preview.runs[0]?.resourceManifest.resources[0]?.releaseEffect,
    'stop',
    'a capability-owned resource is still stopped by parking',
  );
});

test('a running slot-lifecycle resource with no lease is not an unowned capability leak', async () => {
  const ctx = harness([activeRun('run-a', 'slot-a')]);
  const status = statusWithAffectedResources(
    'run-a',
    [{ resourceId: 'browser-cdp', ownership: 'slot-lifecycle', releaseEffect: 'retain' }],
    { leases: false },
  );
  ctx.deps.capabilityStatus = async () => structuredClone(status);
  const preview = await ctx.service.preview({
    machine: 'machine-a',
    mode: 'release',
    selector: { kind: 'all' },
  });
  assert.equal(preview.runs[0]?.eligibility.eligible, true);
  assert.equal(preview.runs[0]?.resourceManifest.resources[0]?.releaseEffect, 'retain');
});

test('parking never stops a retained resource and restore verifies it instead of booting it', async () => {
  const ctx = harness([activeRun('run-a', 'slot-a')]);
  const status = statusWithAffectedResources(
    'run-a',
    [{ resourceId: 'browser-cdp', ownership: 'slot-lifecycle', releaseEffect: 'retain' }],
    { leases: false },
  );
  ctx.deps.capabilityStatus = async () => structuredClone(status);
  const pausePreview = await ctx.service.preview({
    machine: 'machine-a',
    mode: 'release',
    selector: { kind: 'all' },
  });
  const parked = await ctx.service.execute({
    machine: 'machine-a',
    mode: 'release',
    previewId: pausePreview.previewId,
    reviewedTargets: [{ runId: 'run-a', generation: 3 }],
    operationId: 'retain-park',
  });
  assert.equal(parked.ok, true);
  assert.equal(ctx.runs.get('run-a')!.park?.phase, 'parked');
  assert.equal(
    ctx.calls.some((call) => call.startsWith('stop-resource:')),
    false,
    'a retained resource must survive the park',
  );
  assert.equal(ctx.runs.get('run-a')!.park?.resourceManifest.resources[0]?.phase, 'retained');
  assert.equal(ctx.runs.get('run-a')!.park?.residuals.resources[0]?.state, 'running');

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
    operationId: 'retain-restore',
  });
  assert.equal(restored.ok, true);
  assert.equal(ctx.runs.get('run-a')!.park?.phase, 'restored');
  assert.equal(
    ctx.calls.some((call) => call.startsWith('start-resource:')),
    false,
    'restore must verify a retained resource, never boot a second copy of it',
  );
  assert.equal(ctx.runs.get('run-a')!.park?.resourceManifest.resources[0]?.phase, 'restored');
});

test('restore refuses to boot a retained resource that stopped while the run was parked', async () => {
  const ctx = harness([activeRun('run-a', 'slot-a')]);
  const status = statusWithAffectedResources(
    'run-a',
    [{ resourceId: 'browser-cdp', ownership: 'slot-lifecycle', releaseEffect: 'retain' }],
    { leases: false },
  );
  ctx.deps.capabilityStatus = async () => structuredClone(status);
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
    operationId: 'retain-park-lost',
  });
  ctx.deps.observeResources = async () => [{ ...runningResource(), status: 'stopped' }];
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
    operationId: 'retain-restore-lost',
  });
  assert.equal(restored.ok, false);
  assert.equal(
    ctx.calls.some((call) => call.startsWith('start-resource:')),
    false,
  );
  assert.match(
    ctx.runs.get('run-a')!.park?.resourceManifest.resources[0]?.error ?? '',
    /park never stopped it, so restore will not boot it/,
  );
});

test('a foreign lease on a declared slot-action provider surfaces the foreign holder, not unmapped', async () => {
  const ctx = harness([activeRun('run-a', 'slot-a')]);
  const status = statusWithAffectedResources(
    'run-a',
    [{ resourceId: 'browser-cdp', ownership: 'capability', releaseEffect: 'stop' }],
    { slotActions: true, foreignRunId: 'run-foreign' },
  );
  ctx.deps.capabilityStatus = async () => structuredClone(status);
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
});

/**
 * Two providers claiming one resource: a `slot-lifecycle` one the run holds a
 * lease on, and a `capability` one it does not. Codex's reproduction for the
 * ownership-widening defect.
 */
function statusWithTwoClaimants(
  runId: string,
  options: {
    lifecycleLeased?: boolean;
    capabilityLeased?: boolean;
    lifecycleEffect?: 'stop' | 'retain';
    capabilityEffect?: 'stop' | 'retain';
  } = {},
): RuntimeCapabilityStatusResult {
  const status = capabilityStatusFor(runId);
  const capabilityEntry = structuredClone(status.catalog[0]!);
  const lifecycleEntry = structuredClone(status.catalog[0]!);
  lifecycleEntry.id = 'sandbox-gateway-ui';
  lifecycleEntry.label = 'Gateway';
  lifecycleEntry.provenance = { ...lifecycleEntry.provenance, providerId: 'sandbox-gateway-ui' };
  lifecycleEntry.affectedResources = [
    {
      resourceId: 'browser-cdp',
      ownership: 'slot-lifecycle',
      releaseEffect: options.lifecycleEffect ?? 'retain',
    },
  ];
  capabilityEntry.affectedResources = [
    {
      resourceId: 'browser-cdp',
      ownership: 'capability',
      releaseEffect: options.capabilityEffect ?? 'stop',
    },
  ];
  status.catalog = [capabilityEntry, lifecycleEntry];
  const template = status.leases[0]!;
  status.leases = [
    ...(options.capabilityLeased ? [structuredClone(template)] : []),
    ...(options.lifecycleLeased
      ? [
          {
            ...structuredClone(template),
            id: 'lease-gateway',
            capabilityId: 'sandbox-gateway-ui',
            provenance: { ...template.provenance, providerId: 'sandbox-gateway-ui' },
          },
        ]
      : []),
  ];
  status.proofPlans[runId] = {
    version: 1,
    slotId: 'slot-a',
    ownerRunId: runId,
    createdAt: '2026-08-21T00:00:00.000Z',
    requirements: [
      { capabilityId: 'browser-cdp', reason: 'visual proof', mode: 'visual' },
      { capabilityId: 'sandbox-gateway-ui', reason: 'control plane', mode: 'state' },
    ],
  };
  return status;
}

test('a lease on a slot-lifecycle claimant does not satisfy another provider capability claim', async () => {
  const ctx = harness([activeRun('run-a', 'slot-a')]);
  const status = statusWithTwoClaimants('run-a', {
    lifecycleLeased: true,
    capabilityLeased: false,
    // Both agree the resource is stopped on release, so only ownership is under test.
    lifecycleEffect: 'stop',
  });
  ctx.deps.capabilityStatus = async () => structuredClone(status);
  const preview = await ctx.service.preview({
    machine: 'machine-a',
    mode: 'release',
    selector: { kind: 'all' },
  });
  assert.equal(preview.runs[0]?.eligibility.eligible, false);
  assert.equal(preview.runs[0]?.eligibility.code, 'CAPABILITY_RESOURCE_UNOWNED');
  assert.match(preview.runs[0]?.eligibility.reason ?? '', /browser-cdp/);
});

test('a lease on every capability-owned claimant is what makes the resource eligible', async () => {
  const ctx = harness([activeRun('run-a', 'slot-a')]);
  const status = statusWithTwoClaimants('run-a', {
    lifecycleLeased: true,
    capabilityLeased: true,
    lifecycleEffect: 'stop',
  });
  ctx.deps.capabilityStatus = async () => structuredClone(status);
  const preview = await ctx.service.preview({
    machine: 'machine-a',
    mode: 'release',
    selector: { kind: 'all' },
  });
  assert.equal(preview.runs[0]?.eligibility.eligible, true);
});

test('providers that disagree about what a release does to one resource are refused', async () => {
  const ctx = harness([activeRun('run-a', 'slot-a')]);
  // One provider says releasing retains the resource, the other says it stops
  // it. Honouring 'retain' would leave the manifest claiming a resource stays
  // up while the other provider's shutdown hook takes it down.
  const status = statusWithTwoClaimants('run-a', {
    lifecycleLeased: true,
    capabilityLeased: true,
    lifecycleEffect: 'retain',
    capabilityEffect: 'stop',
  });
  ctx.deps.capabilityStatus = async () => structuredClone(status);
  const preview = await ctx.service.preview({
    machine: 'machine-a',
    mode: 'release',
    selector: { kind: 'all' },
  });
  assert.equal(preview.runs[0]?.eligibility.eligible, false);
  assert.equal(preview.runs[0]?.eligibility.code, 'CAPABILITY_CLAIM_CONFLICT');
  assert.match(preview.runs[0]?.eligibility.reason ?? '', /browser-cdp/);
  assert.equal(
    ctx.calls.some((call) => call.startsWith('stop-resource:')),
    false,
    'a conflicting catalog must be refused before any mutation',
  );
});

test('restore inspects a retained resource before it acquires anything', async () => {
  const ctx = harness([activeRun('run-a', 'slot-a')]);
  let status = statusWithAffectedResources('run-a', [
    { resourceId: 'browser-cdp', ownership: 'capability', releaseEffect: 'retain' },
  ]);
  let resourceRunning = true;
  ctx.deps.capabilityStatus = async () => structuredClone(status);
  ctx.deps.observeResources = async () =>
    resourceRunning ? [runningResource()] : [{ ...runningResource(), status: 'stopped' }];
  ctx.deps.releaseCapability = async () => {
    const own = structuredClone(status.leases[0]!);
    status = { ...status, leases: [{ ...own, state: 'released' as const }] };
    return { ok: true, released: [own], retained: [], effects: [], failures: [] };
  };
  // The shipped gateway provider acquires through its resource's own boot
  // action, so an acquire is exactly what silently revives a dead retained
  // resource. Modelling that is the point of this test.
  const acquireCapability = ctx.deps.acquireCapability;
  ctx.deps.acquireCapability = async (params) => {
    resourceRunning = true;
    return acquireCapability(params);
  };

  const pausePreview = await ctx.service.preview({
    machine: 'machine-a',
    mode: 'release',
    selector: { kind: 'all' },
  });
  assert.equal(pausePreview.runs[0]?.eligibility.eligible, true);
  const parked = await ctx.service.execute({
    machine: 'machine-a',
    mode: 'release',
    previewId: pausePreview.previewId,
    reviewedTargets: [{ runId: 'run-a', generation: 3 }],
    operationId: 'retain-with-lease-park',
  });
  assert.equal(parked.ok, true);
  assert.equal(ctx.runs.get('run-a')!.park?.resourceManifest.resources[0]?.phase, 'retained');

  // The retained resource dies while the run is parked.
  resourceRunning = false;
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
    operationId: 'retain-with-lease-restore',
  });

  assert.equal(restored.ok, false, 'a dead retained resource must fail the restore');
  assert.equal(
    ctx.calls.some((call) => call.startsWith('acquire-capability:')),
    false,
    'nothing may be acquired before the retained resources are proven intact',
  );
  assert.equal(
    ctx.calls.some((call) => call.startsWith('start-resource:')),
    false,
  );
  assert.equal(resourceRunning, false, 'the dead retained resource must not have been revived');
  const after = ctx.runs.get('run-a')!.park!;
  assert.equal(after.phase, 'partial', 'the fence stays until an operator looks at it');
  assert.match(
    after.resourceManifest.resources[0]?.error ?? '',
    /park never stopped it, so restore will not boot it/,
  );
});

test('a declared retain resource with no boot hook is parkable, not RESOURCE_HOOKS_UNAVAILABLE', async () => {
  const ctx = harness([activeRun('run-a', 'slot-a')]);
  // The android-device shape: a physical device is health-checked and never
  // booted by us. Requiring a boot hook refused every slot with one attached,
  // before its `retain` declaration was ever read.
  ctx.deps.observeResources = async () => [
    {
      id: 'browser-cdp',
      definition: {
        type: 'device',
        label: 'Android device',
        streamable: false,
        controllable: true,
        hooks: { health: 'adb get-state', shutdown: 'true' },
      },
      status: 'running',
    },
  ];
  const status = statusWithAffectedResources('run-a', [
    { resourceId: 'browser-cdp', ownership: 'capability', releaseEffect: 'retain' },
  ]);
  ctx.deps.capabilityStatus = async () => structuredClone(status);
  const preview = await ctx.service.preview({
    machine: 'machine-a',
    mode: 'release',
    selector: { kind: 'all' },
  });
  assert.equal(preview.runs[0]?.eligibility.eligible, true);
  assert.deepEqual(
    preview.runs[0]?.resourceManifest.resources.map((resource) => ({
      resourceId: resource.resourceId,
      releaseEffect: resource.releaseEffect,
    })),
    [{ resourceId: 'browser-cdp', releaseEffect: 'retain' }],
  );
});

test('a resource with no boot hook and no retain claim is still refused', async () => {
  const ctx = harness([activeRun('run-a', 'slot-a')]);
  ctx.deps.observeResources = async () => [
    {
      id: 'browser-cdp',
      definition: {
        type: 'device',
        label: 'Android device',
        streamable: false,
        controllable: true,
        hooks: { health: 'adb get-state', shutdown: 'true' },
      },
      status: 'running',
    },
  ];
  const status = statusWithAffectedResources('run-a', [
    { resourceId: 'browser-cdp', ownership: 'capability', releaseEffect: 'stop' },
  ]);
  ctx.deps.capabilityStatus = async () => structuredClone(status);
  const preview = await ctx.service.preview({
    machine: 'machine-a',
    mode: 'release',
    selector: { kind: 'all' },
  });
  assert.equal(preview.runs[0]?.eligibility.code, 'RESOURCE_HOOKS_UNAVAILABLE');
});

test('a retain resource with no way to health-check it is refused', async () => {
  const ctx = harness([activeRun('run-a', 'slot-a')]);
  ctx.deps.observeResources = async () => [
    {
      id: 'browser-cdp',
      definition: {
        type: 'device',
        label: 'Opaque device',
        streamable: false,
        controllable: true,
        hooks: { shutdown: 'true' },
      },
      status: 'running',
    },
  ];
  const status = statusWithAffectedResources('run-a', [
    { resourceId: 'browser-cdp', ownership: 'capability', releaseEffect: 'retain' },
  ]);
  ctx.deps.capabilityStatus = async () => structuredClone(status);
  const preview = await ctx.service.preview({
    machine: 'machine-a',
    mode: 'release',
    selector: { kind: 'all' },
  });
  assert.equal(preview.runs[0]?.eligibility.code, 'RESOURCE_HOOKS_UNAVAILABLE');
});

test('a gate park that already released a lease is never treated as zero-effect', async () => {
  const ctx = harness([gateHeldRun('run-gate', 'slot-a')]);
  // A gate park preserves the run's status by design and a retain-only
  // manifest reports every resource running, so with the runner observed back
  // up the residuals are indistinguishable from an intent that never ran. The
  // released lease is the only surviving evidence that it did.
  let status = statusWithAffectedResources('run-gate', [
    { resourceId: 'browser-cdp', ownership: 'capability', releaseEffect: 'retain' },
  ]);
  ctx.deps.capabilityStatus = async () => structuredClone(status);
  ctx.deps.releaseCapability = async () => {
    const own = structuredClone(status.leases[0]!);
    status = { ...status, leases: [{ ...own, state: 'released' as const }] };
    return { ok: true, released: [own], retained: [], effects: [], failures: [] };
  };
  ctx.deps.runnerRunning = async () => 'running';

  const preview = await ctx.service.preview({
    machine: 'machine-a',
    mode: 'release',
    selector: { kind: 'include', runIds: ['run-gate'] },
  });
  const target = preview.runs.find((run) => run.runId === 'run-gate')!;
  assert.equal(target.eligibility.eligible, true);
  await ctx.service.execute({
    machine: 'machine-a',
    mode: 'release',
    previewId: preview.previewId,
    reviewedTargets: [{ runId: 'run-gate', generation: target.generation }],
    operationId: 'gate-released-lease-not-zero-effect',
  });
  const record = ctx.runs.get('run-gate')!.park!;
  assert.equal(record.phase, 'partial');
  assert.equal(record.slotFreedAt, undefined, 'the free must not have landed');
  assert.equal(ctx.runs.get('run-gate')!.status, record.prePauseStatus);
  assert.deepEqual(
    record.residuals.resources.map((resource) => resource.state),
    ['running'],
  );
  assert.equal(record.residuals.runner, 'running');
  assert.equal(record.resourceManifest.capabilityLeases[0]?.state, 'released');

  await ctx.service.reconcile();
  assert.notEqual(
    ctx.runs.get('run-gate')!.park,
    null,
    'a record whose leases were released is not zero-effect and must not be discarded',
  );
});
