import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import {
  type MachineParkRecord,
  type MachinePauseExecuteParams,
  type MachinePauseExecuteResult,
  type MachinePausePreviewParams,
  type MachinePausePreviewResult,
  type ProjectResourcePostureConfig,
  RESOURCE_POSTURE_TRANSITION_HISTORY,
  type ResourcePostureTransition,
  type Run,
  type RuntimeCapabilityCatalogEntry,
  type RuntimeCapabilityProviderActionRef,
  type RuntimeCapabilityReleaseResult,
} from '@farmslot/protocol';

import { MachinePausePreviewStaleError } from '../machine-parking/preview-errors.js';
import { prepareRunPostureForValidation } from '../run-engine/resource-posture.js';

import {
  type PostureWarmSweepResult,
  resolveEffectivePosturePolicy,
  RunResourcePostureReconciler,
} from './posture.js';
import { RuntimeCapabilityRegistry } from './registry.js';
import { RuntimeCapabilityStore } from './store.js';

const SLOT = 'slot-a';

function runsHistory(
  reconciler: RunResourcePostureReconciler,
  runId: string,
): ResourcePostureTransition[] {
  const runs = (reconciler as unknown as { deps: { getRun: (id: string) => Run | undefined } })
    .deps;
  return runs.getRun(runId)?.resourcePosture?.recentTransitions ?? [];
}
const MACHINE = 'macwork';

function entry(
  id: string,
  overrides: Partial<RuntimeCapabilityCatalogEntry> = {},
): RuntimeCapabilityCatalogEntry {
  const action = (name: string): RuntimeCapabilityProviderActionRef => ({
    kind: 'slot-action',
    actionId: `${id}.${name}`,
  });
  return {
    id,
    project: 'test-project',
    label: id,
    version: '1',
    dependencies: [],
    sharePolicy: 'exclusive',
    cost: { class: 'low', resources: [] },
    actions: { acquire: action('acquire'), health: action('health'), release: action('release') },
    releaseEffects: [`release ${id}`],
    provenance: { project: 'test-project', providerId: id, version: '1', digest: `digest-${id}` },
    availability: { state: 'available' },
    ...overrides,
  };
}

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run-a',
    familyId: 'fam-a',
    slotId: SLOT,
    status: 'monitoring',
    updatedAt: '2026-08-11T00:00:00.000Z',
    ...overrides,
  } as unknown as Run;
}

interface HarnessOptions {
  capabilities: RuntimeCapabilityCatalogEntry[];
  run?: Run;
  projectPosture?: ProjectResourcePostureConfig;
  runAction?: (
    slotId: string,
    action: RuntimeCapabilityProviderActionRef,
    parameters: Record<string, unknown>,
    declaredParameters: readonly string[],
  ) => { ok: boolean; detail?: string };
  parkPreview?: (params: MachinePausePreviewParams) => Promise<MachinePausePreviewResult>;
  parkExecute?: (params: MachinePauseExecuteParams) => Promise<MachinePauseExecuteResult>;
  /** Simulate a status read taken while an acquire is still in flight. */
  hideLeasesOnFirstStatus?: boolean;
  /** Force the registry to report a lease it refused to release. */
  retainOnRelease?: string[];
  /** Replace the warm-sweep result the reconciler sees. */
  warmSweepResult?: PostureWarmSweepResult;
  now?: () => Date;
  storePath?: string;
}

async function harness(t: TestContext, options: HarnessOptions) {
  const directory = options.storePath
    ? path.dirname(options.storePath)
    : await mkdtemp(path.join(os.tmpdir(), 'run-resource-posture-'));
  if (!options.storePath) t.after(() => rm(directory, { recursive: true, force: true }));
  const storePath = options.storePath ?? path.join(directory, 'leases.json');
  const actions: string[] = [];
  /** Every provider action with the acquire parameters it was run for. */
  const actionCalls: Array<{ action: string; parameters: Record<string, unknown> }> = [];
  let nextLease = 0;
  const now = options.now ?? (() => new Date('2026-08-11T00:00:00.000Z'));
  const registry = new RuntimeCapabilityRegistry({
    store: new RuntimeCapabilityStore(storePath),
    catalogForSlot: async (slotId) => ({
      slotId,
      project: 'test-project',
      capabilities: options.capabilities,
      ...(options.projectPosture ? { posture: options.projectPosture } : {}),
    }),
    runAction: async (slotId, action, parameters, declaredParameters) => {
      const name =
        action.kind === 'slot-action' ? action.actionId : `${action.resourceId}.${action.action}`;
      actions.push(name);
      actionCalls.push({ action: name, parameters });
      return options.runAction?.(slotId, action, parameters, declaredParameters) ?? { ok: true };
    },
    leaseId: () => `lease-${++nextLease}`,
    now,
  });

  let staleReadUsed = false;
  const withForcedRetention = (result: RuntimeCapabilityReleaseResult) => {
    if (!options.retainOnRelease?.length) return result;
    const retained = result.released.filter((lease) =>
      options.retainOnRelease!.includes(lease.capabilityId),
    );
    return {
      ...result,
      released: result.released.filter((lease) => !retained.includes(lease)),
      retained: [...result.retained, ...retained],
    };
  };
  const runs = new Map<string, Run>();
  const run = options.run ?? makeRun();
  runs.set(run.id, run);
  const broadcasts: Run[] = [];
  const parkCalls: Array<MachinePausePreviewParams | MachinePauseExecuteParams> = [];

  const defaultPreview = async (
    params: MachinePausePreviewParams,
  ): Promise<MachinePausePreviewResult> => ({
    previewId: 'preview-1',
    machine: params.machine,
    mode: params.mode,
    selector: params.selector,
    createdAt: now().toISOString(),
    runs: [
      {
        runId: run.id,
        generation: 3,
        selected: true,
        slotId: SLOT,
        status: 'monitoring',
        currentStep: null,
        slotDisposition: 'retained',
        eligibility: {
          eligible: true,
          code: 'ELIGIBLE_RELEASE_PAUSE',
          reason: 'idempotent monitoring phase',
        },
        recoveryPolicy: { kind: 'runner-session-reload', supported: true, runnerId: 'claude' },
        resourceManifest: { capturedAt: now().toISOString(), resources: [], capabilityLeases: [] },
      },
    ],
    eligibleCount: 1,
    rejectedCount: 0,
  });

  const reconciler = new RunResourcePostureReconciler({
    getRun: (runId) => runs.get(runId),
    updateRun: (runId, partial) => {
      const current = runs.get(runId)!;
      const updated = { ...current, ...partial } as Run;
      runs.set(runId, updated);
      return updated;
    },
    capabilityStatus: async (slotId) => {
      const status = await registry.status({ slotId });
      if (options.hideLeasesOnFirstStatus && !staleReadUsed) {
        staleReadUsed = true;
        // What the reconciler sees while an acquire is still in flight: the
        // leases that acquire is about to create are simply not there yet.
        return { ...status, leases: [] };
      }
      return status;
    },
    acquireCapability: (params) => registry.acquire(params),
    enqueueScopedClaimWaiter: (params) => registry.enqueueScopedClaimWaiter(params),
    releaseForPosture: async (slotId, dispositions) =>
      withForcedRetention(await registry.releaseForPosture(slotId, dispositions)),
    stopWarmProviders: async (slotId, capabilityIds) => {
      const swept = await registry.stopWarmProviders(slotId, capabilityIds);
      return options.warmSweepResult ?? swept;
    },
    releaseRunTerminal: async (slotId, ownerRunId, familyId) =>
      withForcedRetention(await registry.releaseRunTerminal(slotId, ownerRunId, familyId)),
    machineForSlot: async () => MACHINE,
    parkPreview: async (params) => {
      parkCalls.push(params);
      return (options.parkPreview ?? defaultPreview)(params);
    },
    parkExecute: async (params) => {
      parkCalls.push(params);
      if (options.parkExecute) return options.parkExecute(params);
      // Production's `machinePauseExecute` writes the park record onto the run,
      // and the record — not the persisted posture — is what says a run is
      // parked. A stub that skipped it let "already parked" mean nothing more
      // than a matching posture string.
      const parked = runs.get(run.id);
      if (parked) parked.park = parkRecord(run.id, params.machine, params.operationId ?? 'op');
      return {
        ok: true,
        outcome: 'complete',
        operationId: params.operationId ?? 'op',
        machine: params.machine,
        mode: params.mode,
        records: parked?.park ? [parked.park] : [],
      };
    },
    onRunUpdated: (updated) => broadcasts.push(updated),
    now,
    newOperationId: () => 'op-generated',
  });

  return {
    registry,
    reconciler,
    actions,
    actionCalls,
    runs,
    broadcasts,
    parkCalls,
    storePath,
    directory,
    run,
  };
}

/** The record a completed release park leaves on the run. */
function parkRecord(runId: string, machine: string, operationId: string): MachineParkRecord {
  const at = '2026-09-05T00:00:00.000Z';
  return {
    version: 1,
    operationId,
    previewId: 'preview-1',
    runId,
    generation: 3,
    machine,
    slotId: SLOT,
    mode: 'release',
    phase: 'parked',
    prePauseStatus: 'monitoring',
    prePauseCurrentStep: { index: 0, name: 'monitor', status: 'running' },
    resourceManifest: { capturedAt: at, resources: [], capabilityLeases: [] },
    recoveryHandle: null,
    errors: [],
    residuals: { runner: 'stopped', resources: [] },
    createdAt: at,
    updatedAt: at,
    parkedAt: at,
  };
}

function acquire(
  registry: RuntimeCapabilityRegistry,
  capabilityId: string,
  ownerRunId: string,
  ownerFamilyId = 'fam-a',
) {
  return registry.acquire({
    slotId: SLOT,
    capabilityId,
    ownerRunId,
    ownerFamilyId,
    proofRequirement: { capabilityId, reason: `prove ${capabilityId}`, mode: 'state' },
  });
}

const CATALOG_METRO = entry('metro', {
  cost: { class: 'high', resources: [] },
  keepWarmMs: 600_000,
});
const CATALOG_LINT = entry('lint', { cost: { class: 'low', resources: [] } });

test('precedence resolves gate choice over waitPolicy over project default over framework default', () => {
  const input = {
    posture: 'operator-wait' as const,
    catalog: [CATALOG_METRO],
    proofRequirements: [],
    capabilityIds: ['metro'],
  };

  const framework = resolveEffectivePosturePolicy(input);
  assert.equal(framework.policySource, 'framework-default');
  assert.equal(framework.perCapability.get('metro')?.desired, 'warm');

  const project = resolveEffectivePosturePolicy({
    ...input,
    projectPosture: { defaults: { 'operator-wait': 'stop' } },
  });
  assert.equal(project.policySource, 'project-default');
  assert.equal(project.perCapability.get('metro')?.desired, 'stopped');

  const dispatch = resolveEffectivePosturePolicy({
    ...input,
    projectPosture: { defaults: { 'operator-wait': 'stop' } },
    waitPolicy: 'keep-for-validation',
  });
  assert.equal(dispatch.posture, 'active');
  assert.equal(dispatch.policySource, 'run-dispatch');

  const gate = resolveEffectivePosturePolicy({
    ...input,
    projectPosture: { defaults: { 'operator-wait': 'stop' } },
    waitPolicy: 'keep-for-validation',
    gateChoice: 'free-slot',
  });
  assert.equal(gate.posture, 'parked');
  assert.equal(gate.policySource, 'gate-choice');
  assert.equal(gate.gateChoice, 'free-slot');

  // `project-default` defers instead of deciding.
  const deferred = resolveEffectivePosturePolicy({
    ...input,
    waitPolicy: 'minimize',
    gateChoice: 'project-default',
  });
  assert.equal(deferred.policySource, 'run-dispatch');
  assert.equal(deferred.posture, 'operator-wait');
});

test('provider retention overrides project posture defaults for that provider only', () => {
  const policy = resolveEffectivePosturePolicy({
    posture: 'operator-wait',
    catalog: [
      entry('metro', {
        cost: { class: 'high', resources: [] },
        keepWarmMs: 1000,
        retention: { 'operator-wait': 'retain' },
      }),
      CATALOG_LINT,
    ],
    projectPosture: { defaults: { 'operator-wait': 'stop' } },
    proofRequirements: [],
    capabilityIds: ['metro', 'lint'],
  });
  assert.equal(policy.perCapability.get('metro')?.desired, 'acquired');
  assert.equal(policy.perCapability.get('lint')?.desired, 'stopped');
});

test('terminal reconcile stops run and family providers and repeats idempotently', async (t) => {
  const { reconciler, registry, runs, actions } = await harness(t, {
    capabilities: [CATALOG_METRO, CATALOG_LINT],
  });
  assert.equal((await acquire(registry, 'metro', 'run-a')).ok, true);
  assert.equal((await acquire(registry, 'lint', 'run-a')).ok, true);
  actions.length = 0;

  const first = await reconciler.apply({ runId: 'run-a', posture: 'terminal' });
  assert.equal(first.ok, true);
  assert.equal(first.transition.outcome, 'applied');
  // Terminal bypasses keep-warm: metro's release action really ran.
  assert.ok(actions.includes('metro.release'));
  assert.ok(actions.includes('lint.release'));
  assert.deepEqual(first.status.capabilities.map((state) => state.desiredDisposition).sort(), [
    'stopped',
    'stopped',
  ]);
  assert.equal(runs.get('run-a')?.resourcePosture?.posture, 'terminal');

  actions.length = 0;
  const repeat = await reconciler.apply({ runId: 'run-a', posture: 'terminal' });
  assert.equal(repeat.transition.outcome, 'idempotent');
  assert.deepEqual(actions, []);
});

test('an operationId replay returns the stored transition without provider actions', async (t) => {
  const { reconciler, registry, actions } = await harness(t, { capabilities: [CATALOG_LINT] });
  await acquire(registry, 'lint', 'run-a');
  const first = await reconciler.apply({
    runId: 'run-a',
    posture: 'terminal',
    operationId: 'op-1',
  });
  actions.length = 0;
  const replay = await reconciler.apply({
    runId: 'run-a',
    posture: 'terminal',
    operationId: 'op-1',
  });
  assert.equal(replay.transition.id, first.transition.id);
  assert.equal(replay.transition.outcome, first.transition.outcome);
  assert.deepEqual(actions, []);
});

test('dependents release before dependencies', async (t) => {
  const { reconciler, registry, actions } = await harness(t, {
    capabilities: [entry('app', { dependencies: ['metro'] }), CATALOG_METRO],
  });
  assert.equal((await acquire(registry, 'app', 'run-a')).ok, true);
  actions.length = 0;
  await reconciler.apply({ runId: 'run-a', posture: 'terminal' });
  const releases = actions.filter((action) => action.endsWith('.release'));
  assert.deepEqual(releases, ['app.release', 'metro.release']);
});

test('a shared provider another holder still needs is retained, not stopped', async (t) => {
  const { reconciler, registry, actions } = await harness(t, {
    capabilities: [entry('shared-db', { sharePolicy: 'shared' })],
  });
  assert.equal((await acquire(registry, 'shared-db', 'run-a')).ok, true);
  // A different family, so terminal for run-a's family must not select it.
  assert.equal((await acquire(registry, 'shared-db', 'run-b', 'fam-b')).ok, true);
  actions.length = 0;
  const result = await reconciler.apply({ runId: 'run-a', posture: 'terminal' });
  assert.equal(result.ok, true);
  assert.ok(!actions.includes('shared-db.release'));
  const status = await registry.status({ slotId: SLOT, ownerRunId: 'run-b' });
  assert.equal(status.leases[0]?.state, 'acquired');
});

test('operator-wait warms a high-cost provider and status reports it running, not stopped', async (t) => {
  const { reconciler, registry, actions } = await harness(t, { capabilities: [CATALOG_METRO] });
  assert.equal((await acquire(registry, 'metro', 'run-a')).ok, true);
  actions.length = 0;
  const result = await reconciler.apply({ runId: 'run-a', posture: 'operator-wait' });
  assert.equal(result.transition.outcome, 'applied');
  // Warm keeps the provider alive: no release action, and a warm deadline.
  assert.ok(!actions.includes('metro.release'));
  const state = result.status.capabilities[0];
  assert.equal(state.desiredDisposition, 'warm');
  assert.equal(state.observedState, 'running');
  assert.ok(state.warmUntil);
  assert.equal(result.status.workerRetained, true);
});

test('a stopped disposition bypasses keep-warm without bypassing the provenance guard', async (t) => {
  const { reconciler, registry, actions } = await harness(t, {
    capabilities: [CATALOG_METRO],
    projectPosture: { defaults: { 'operator-wait': 'stop' } },
  });
  assert.equal((await acquire(registry, 'metro', 'run-a')).ok, true);
  actions.length = 0;
  const result = await reconciler.apply({ runId: 'run-a', posture: 'operator-wait' });
  assert.ok(actions.includes('metro.release'));
  const state = result.status.capabilities[0];
  assert.equal(state.desiredDisposition, 'stopped');
  assert.equal(state.observedState, 'stopped');
  assert.deepEqual(result.transition.effects, ['release metro']);
});

test('a cleanup failure records partial and never claims the provider stopped', async (t) => {
  const { reconciler, registry } = await harness(t, {
    capabilities: [CATALOG_LINT],
    runAction: (_slot, action) =>
      action.kind === 'slot-action' && action.actionId === 'lint.release'
        ? { ok: false, detail: 'shutdown exited 1' }
        : { ok: true },
  });
  assert.equal((await acquire(registry, 'lint', 'run-a')).ok, true);
  const result = await reconciler.apply({ runId: 'run-a', posture: 'terminal' });
  assert.equal(result.ok, false);
  assert.equal(result.transition.outcome, 'partial');
  assert.equal(result.transition.failures[0]?.capabilityId, 'lint');
  const state = result.status.capabilities[0];
  assert.notEqual(state.observedState, 'stopped');
  assert.equal(state.observedState, 'unhealthy');
  assert.equal(state.cleanupFailure, 'shutdown exited 1');
});

test('active acquires the proof plan and blocks with a typed reason when it cannot', async (t) => {
  const { reconciler, registry } = await harness(t, {
    capabilities: [entry('browser')],
  });
  // Another owner already holds the exclusive provider.
  assert.equal((await acquire(registry, 'browser', 'other-run')).ok, true);
  const result = await reconciler.apply({
    runId: 'run-a',
    posture: 'active',
    proofRequirements: [{ capabilityId: 'browser', reason: 'validation', mode: 'visual' }],
  });
  assert.equal(result.ok, false);
  assert.equal(result.transition.outcome, 'rejected');
  assert.equal(result.transition.rejection?.kind, 'capability-unavailable');
  // The other owner's lease is untouched.
  const status = await registry.status({ slotId: SLOT, ownerRunId: 'other-run' });
  assert.equal(status.leases[0]?.state, 'acquired');
});

test('parked delegates to machine parking with a single-run include selector', async (t) => {
  const { reconciler, parkCalls, actions, registry } = await harness(t, {
    capabilities: [CATALOG_LINT],
  });
  await acquire(registry, 'lint', 'run-a');
  actions.length = 0;
  const result = await reconciler.apply({ runId: 'run-a', posture: 'parked' });
  assert.equal(result.ok, true);
  assert.equal(result.transition.outcome, 'applied');
  const preview = parkCalls[0] as MachinePausePreviewParams;
  assert.deepEqual(preview.selector, { kind: 'include', runIds: ['run-a'] });
  assert.equal(preview.mode, 'release');
  const execute = parkCalls[1] as MachinePauseExecuteParams;
  assert.deepEqual(execute.reviewedTargets, [{ runId: 'run-a', generation: 3 }]);
  // Parking owns the stops; the reconciler ran no provider action of its own.
  assert.deepEqual(actions, []);
  assert.equal(result.status.workerRetained, false);
});

test('parked on an ineligible run is a typed rejection with no lease or process change', async (t) => {
  const gateHeld = makeRun({ status: 'human-gating' });
  const { reconciler, registry, actions, parkCalls, runs } = await harness(t, {
    capabilities: [CATALOG_LINT],
    run: gateHeld,
    parkPreview: async (params) => ({
      previewId: 'preview-1',
      machine: params.machine,
      mode: params.mode,
      selector: params.selector,
      createdAt: '2026-08-11T00:00:00.000Z',
      runs: [
        {
          runId: 'run-a',
          generation: 1,
          selected: true,
          slotId: SLOT,
          status: 'human-gating',
          currentStep: null,
          slotDisposition: 'retained',
          eligibility: {
            eligible: false,
            code: 'STATUS_NOT_ELIGIBLE',
            reason: "status 'human-gating' is not monitoring or ci-watching",
          },
          recoveryPolicy: { kind: 'runner-session-reload', supported: false, runnerId: 'claude' },
          resourceManifest: {
            capturedAt: '2026-08-11T00:00:00.000Z',
            resources: [],
            capabilityLeases: [],
          },
        },
      ],
      eligibleCount: 0,
      rejectedCount: 1,
    }),
  });
  assert.equal((await acquire(registry, 'lint', 'run-a')).ok, true);
  actions.length = 0;
  const result = await reconciler.apply({ runId: 'run-a', posture: 'parked' });
  assert.equal(result.ok, false);
  assert.equal(result.transition.outcome, 'rejected');
  assert.deepEqual(result.transition.rejection, {
    kind: 'park-ineligible',
    code: 'STATUS_NOT_ELIGIBLE',
    reason: "status 'human-gating' is not monitoring or ci-watching",
  });
  // No execute, no provider action, and the persisted posture did not flip.
  assert.equal(parkCalls.length, 1);
  assert.deepEqual(actions, []);
  assert.notEqual(runs.get('run-a')?.resourcePosture?.posture, 'parked');
  const status = await registry.status({ slotId: SLOT, ownerRunId: 'run-a' });
  assert.equal(status.leases[0]?.state, 'acquired');
});

test('operator-wait on a gate-held run never reaches an agent or worker dependency', async (t) => {
  const gateHeld = makeRun({ status: 'human-gating' });
  const { reconciler, registry, actions } = await harness(t, {
    capabilities: [CATALOG_METRO, CATALOG_LINT],
    run: gateHeld,
  });
  assert.equal((await acquire(registry, 'metro', 'run-a')).ok, true);
  assert.equal((await acquire(registry, 'lint', 'run-a')).ok, true);
  actions.length = 0;
  const result = await reconciler.apply({ runId: 'run-a', posture: 'operator-wait' });
  assert.equal(result.status.workerRetained, true);
  // Every action the reconciler can reach is a declared capability provider
  // action; there is no agent, tmux, or kill dependency in its surface at all.
  for (const action of actions) {
    assert.ok(
      /^(metro|lint)\.(acquire|health|release)$/.test(action),
      `unexpected provider action ${action}`,
    );
  }
});

test('reconnecting clients see persisted posture, warm deadline, and cleanup failure', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'run-resource-posture-reconnect-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const storePath = path.join(directory, 'leases.json');
  const first = await harness(t, { capabilities: [CATALOG_METRO], storePath });
  assert.equal((await acquire(first.registry, 'metro', 'run-a')).ok, true);
  const applied = await first.reconciler.apply({ runId: 'run-a', posture: 'operator-wait' });
  assert.equal(applied.status.capabilities[0].desiredDisposition, 'warm');
  const persistedRun = first.runs.get('run-a')!;

  // A fresh registry + reconciler over the same store is what a restarted
  // gateway (or a reconnecting client) sees.
  const second = await harness(t, {
    capabilities: [CATALOG_METRO],
    storePath,
    run: persistedRun,
  });
  const status = await second.reconciler.status('run-a');
  assert.equal(status.state.posture, 'operator-wait');
  assert.equal(status.state.policySource, 'framework-default');
  const state = status.state.capabilities[0];
  assert.equal(state.desiredDisposition, 'warm');
  assert.equal(state.observedState, 'running');
  assert.equal(state.warmUntil, applied.status.capabilities[0].warmUntil);
  assert.equal(status.state.lastTransition?.outcome, 'applied');
});

test('preview reports acquire, retain, warm, stop, and declared release effects', async (t) => {
  const { reconciler, registry } = await harness(t, {
    capabilities: [CATALOG_METRO, CATALOG_LINT],
  });
  assert.equal((await acquire(registry, 'metro', 'run-a')).ok, true);
  assert.equal((await acquire(registry, 'lint', 'run-a')).ok, true);
  const plan = await reconciler.preview({ runId: 'run-a', posture: 'operator-wait' });
  assert.equal(plan.posture, 'operator-wait');
  assert.deepEqual(
    plan.warm.map((state) => state.capabilityId),
    ['metro'],
  );
  assert.deepEqual(
    plan.retain.map((state) => state.capabilityId),
    ['lint'],
  );
  assert.deepEqual(plan.stop, []);

  const terminal = await reconciler.preview({ runId: 'run-a', posture: 'terminal' });
  assert.deepEqual(terminal.stop.map((state) => state.capabilityId).sort(), ['lint', 'metro']);
  assert.deepEqual(terminal.effects.sort(), ['release lint', 'release metro']);
});

test('a run with no slot is a typed invalid-request rejection that changes no posture', async (t) => {
  const { reconciler, runs } = await harness(t, {
    capabilities: [CATALOG_LINT],
    run: makeRun({ slotId: null }),
  });
  const result = await reconciler.apply({
    runId: 'run-a',
    posture: 'terminal',
    operationId: 'op-rejected',
  });
  assert.equal(result.ok, false);
  assert.equal(result.transition.rejection?.kind, 'invalid-request');
  // The requested posture was never applied.
  assert.notEqual(runs.get('run-a')?.resourcePosture?.posture, 'terminal');
  // But the rejection is durable, so replaying its id cannot execute for real.
  assert.equal(runs.get('run-a')?.resourcePosture?.lastTransition?.id, 'op-rejected');
  const replay = await reconciler.apply({
    runId: 'run-a',
    posture: 'terminal',
    operationId: 'op-rejected',
  });
  assert.equal(replay.transition.outcome, 'rejected');
  assert.equal(replay.transition.rejection?.kind, 'invalid-request');
});

test('terminal stops a provider even when project retention asks to keep it warm', async (t) => {
  // Config validation rejects `terminal: warm`, but a hand-edited or legacy
  // project must still not be able to keep a provider alive past the run.
  const { reconciler, registry, actions } = await harness(t, {
    capabilities: [
      entry('metro', {
        cost: { class: 'high', resources: [] },
        keepWarmMs: 600_000,
        retention: { terminal: 'warm' },
      }),
    ],
    projectPosture: { defaults: { terminal: 'warm' } },
  });
  assert.equal((await acquire(registry, 'metro', 'run-a')).ok, true);
  actions.length = 0;
  const result = await reconciler.apply({ runId: 'run-a', posture: 'terminal' });
  assert.equal(result.status.capabilities[0].desiredDisposition, 'stopped');
  assert.ok(actions.includes('metro.release'), 'terminal must bypass keep-warm');
  assert.equal(result.status.capabilities[0].observedState, 'stopped');
});

test('an elapsed keep-warm window is not reported as a stopped provider', async (t) => {
  let clock = new Date('2026-08-11T00:00:00.000Z');
  const { reconciler, registry, actions } = await harness(t, {
    capabilities: [CATALOG_METRO],
    now: () => clock,
  });
  assert.equal((await acquire(registry, 'metro', 'run-a')).ok, true);
  await reconciler.apply({ runId: 'run-a', posture: 'operator-wait' });

  // Past the deadline, before the keep-warm sweeper has run: the provider may
  // still be alive and any cleanup failure is still unknown.
  clock = new Date('2026-08-11T01:00:00.000Z');
  const status = await reconciler.status('run-a');
  assert.equal(status.state.capabilities[0].observedState, 'unknown');
  assert.equal(status.state.capabilities[0].warmUntil, undefined);

  // So a terminal reconcile still runs a real release rather than assuming stopped.
  actions.length = 0;
  const terminal = await reconciler.apply({ runId: 'run-a', posture: 'terminal' });
  assert.ok(actions.includes('metro.release'));
  assert.equal(terminal.status.capabilities[0].observedState, 'stopped');
});

test('family terminal releases every sibling lease on a shared capability', async (t) => {
  const { reconciler, registry, actions } = await harness(t, {
    capabilities: [entry('shared-db', { sharePolicy: 'shared' })],
  });
  // Two runs in the same family both hold the capability.
  assert.equal((await acquire(registry, 'shared-db', 'run-a')).ok, true);
  assert.equal((await acquire(registry, 'shared-db', 'sibling-run')).ok, true);
  actions.length = 0;

  const result = await reconciler.apply({ runId: 'run-a', posture: 'terminal' });
  assert.equal(result.ok, true);
  // Both leases are gone and the provider actually stopped.
  const after = await registry.status({ slotId: SLOT });
  assert.deepEqual(
    after.leases.filter((lease) => lease.state === 'acquired'),
    [],
  );
  assert.ok(actions.includes('shared-db.release'));
  assert.equal(result.status.capabilities[0].observedState, 'stopped');
});

test('status never reports stopped while a sibling family lease still holds the capability', async (t) => {
  const { reconciler, registry } = await harness(t, {
    capabilities: [entry('shared-db', { sharePolicy: 'shared' })],
    runAction: (_slot, action) =>
      action.kind === 'slot-action' && action.actionId === 'shared-db.release'
        ? { ok: false, detail: 'shared-db shutdown exited 1' }
        : { ok: true },
  });
  // Two siblings in the same family hold the capability before terminal runs.
  assert.equal((await acquire(registry, 'shared-db', 'run-a')).ok, true);
  assert.equal((await acquire(registry, 'shared-db', 'sibling-run')).ok, true);

  await reconciler.apply({ runId: 'run-a', posture: 'terminal' });
  const status = await reconciler.status('run-a');
  const state = status.state.capabilities.find((item) => item.capabilityId === 'shared-db');
  assert.notEqual(
    state?.observedState,
    'stopped',
    'the provider did not stop, so status must not say it did',
  );
  assert.equal(state?.cleanupFailure, 'shared-db shutdown exited 1');
});

test('a refused park keeps the posture the run actually had', async (t) => {
  const { reconciler, registry, runs, actions } = await harness(t, {
    capabilities: [CATALOG_LINT],
    // Preview accepts, then the execute refuses the way a stale preview does.
    parkExecute: async () => {
      throw new MachinePausePreviewStaleError(
        'machine pause preview is stale; preview the batch again',
      );
    },
  });
  assert.equal((await acquire(registry, 'lint', 'run-a')).ok, true);
  // Establish a real prior posture first.
  await reconciler.apply({ runId: 'run-a', posture: 'operator-wait' });
  assert.equal(runs.get('run-a')?.resourcePosture?.posture, 'operator-wait');
  actions.length = 0;

  const result = await reconciler.apply({ runId: 'run-a', posture: 'parked' });
  assert.equal(result.ok, false);
  assert.equal(result.transition.outcome, 'rejected');
  assert.equal(result.transition.rejection?.kind, 'park-ineligible');
  // Parking changed nothing, so the run must not advertise itself as parked
  // with its worker reported stopped.
  assert.equal(result.status.posture, 'operator-wait');
  assert.equal(result.status.workerRetained, true);
  assert.equal(runs.get('run-a')?.resourcePosture?.posture, 'operator-wait');
  assert.deepEqual(actions, []);
});

test('a stale preview digest is coded apart from a refused execute', async (t) => {
  const { reconciler, registry } = await harness(t, {
    capabilities: [CATALOG_LINT],
    parkExecute: async () => {
      throw new MachinePausePreviewStaleError(
        'machine pause preview is stale; preview the batch again',
      );
    },
  });
  assert.equal((await acquire(registry, 'lint', 'run-a')).ok, true);

  const result = await reconciler.apply({ runId: 'run-a', posture: 'parked' });
  assert.equal(result.transition.rejection?.kind, 'park-ineligible');
  // The race gets its own code so a caller never has to read the sentence to
  // tell it from a batch the gateway genuinely refused.
  assert.equal(
    result.transition.rejection?.kind === 'park-ineligible'
      ? result.transition.rejection.code
      : undefined,
    'MACHINE_PAUSE_PREVIEW_STALE',
  );
});

test('an execute refusal that is not a stale digest keeps the refused code', async (t) => {
  const { reconciler, registry } = await harness(t, {
    capabilities: [CATALOG_LINT],
    parkExecute: async () => {
      throw new Error('machine pause batch was rejected by the operator review');
    },
  });
  assert.equal((await acquire(registry, 'lint', 'run-a')).ok, true);

  const result = await reconciler.apply({ runId: 'run-a', posture: 'parked' });
  assert.equal(
    result.transition.rejection?.kind === 'park-ineligible'
      ? result.transition.rejection.code
      : undefined,
    'PARK_EXECUTE_REFUSED',
  );
});

test('replaying an operation that ended partial reports partial, not success', async (t) => {
  const { reconciler, registry } = await harness(t, {
    capabilities: [CATALOG_LINT],
    runAction: (_slot, action) =>
      action.kind === 'slot-action' && action.actionId === 'lint.release'
        ? { ok: false, detail: 'shutdown exited 1' }
        : { ok: true },
  });
  assert.equal((await acquire(registry, 'lint', 'run-a')).ok, true);
  const first = await reconciler.apply({
    runId: 'run-a',
    posture: 'terminal',
    operationId: 'op-partial',
  });
  assert.equal(first.transition.outcome, 'partial');
  assert.equal(first.ok, false);

  const replay = await reconciler.apply({
    runId: 'run-a',
    posture: 'terminal',
    operationId: 'op-partial',
  });
  assert.equal(replay.transition.outcome, 'partial');
  assert.equal(replay.ok, false, 'a replayed partial must not report success');
});

test('active releases an obsolete lease before acquiring one that claims the same resource', async (t) => {
  const claim = { id: 'cdp-port', access: 'exclusive' as const };
  const { reconciler, registry, actions } = await harness(t, {
    capabilities: [
      entry('browser-old', { cost: { class: 'high', resources: [claim] } }),
      entry('browser-new', { cost: { class: 'high', resources: [claim] } }),
    ],
  });
  assert.equal((await acquire(registry, 'browser-old', 'run-a')).ok, true);
  actions.length = 0;

  // The proof plan now needs the other capability, which claims the same
  // exclusive resource. Acquiring first would conflict the run against itself.
  const result = await reconciler.apply({
    runId: 'run-a',
    posture: 'active',
    proofRequirements: [{ capabilityId: 'browser-new', reason: 'validation', mode: 'visual' }],
  });
  assert.equal(result.transition.rejection, undefined, JSON.stringify(result.transition));
  assert.equal(result.ok, true);
  assert.ok(
    actions.indexOf('browser-old.release') < actions.indexOf('browser-new.acquire'),
    `expected release before acquire, got ${actions.join(', ')}`,
  );
});

test('a cleanup failure survives a restart and is still reported to a reconnecting client', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'run-resource-posture-failure-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const storePath = path.join(directory, 'leases.json');
  const first = await harness(t, {
    capabilities: [CATALOG_LINT],
    storePath,
    runAction: (_slot, action) =>
      action.kind === 'slot-action' && action.actionId === 'lint.release'
        ? { ok: false, detail: 'shutdown exited 1' }
        : { ok: true },
  });
  assert.equal((await acquire(first.registry, 'lint', 'run-a')).ok, true);
  const applied = await first.reconciler.apply({ runId: 'run-a', posture: 'terminal' });
  assert.equal(applied.transition.outcome, 'partial');
  const persistedRun = first.runs.get('run-a')!;

  const second = await harness(t, {
    capabilities: [CATALOG_LINT],
    storePath,
    run: persistedRun,
  });
  const status = await second.reconciler.status('run-a');
  const state = status.state.capabilities[0];
  assert.equal(state.cleanupFailure, 'shutdown exited 1');
  assert.notEqual(state.observedState, 'stopped');
  assert.equal(status.state.lastTransition?.outcome, 'partial');
  assert.equal(status.state.lastTransition?.failures[0]?.capabilityId, 'lint');
});

test('recordFailure persists an unreachable reconcile without changing the posture', async (t) => {
  const { reconciler, registry, runs } = await harness(t, { capabilities: [CATALOG_LINT] });
  assert.equal((await acquire(registry, 'lint', 'run-a')).ok, true);
  await reconciler.apply({ runId: 'run-a', posture: 'operator-wait' });

  const state = await reconciler.recordFailure(
    'run-a',
    'terminal',
    'Project capability catalog unavailable',
  );
  assert.equal(state?.posture, 'operator-wait', 'the failed posture was never applied');
  assert.equal(state?.lastTransition?.outcome, 'failed');
  assert.equal(state?.lastTransition?.posture, 'terminal');
  assert.equal(
    state?.lastTransition?.failures[0]?.reason,
    'Project capability catalog unavailable',
  );
  assert.equal(runs.get('run-a')?.resourcePosture?.lastTransition?.outcome, 'failed');
});

test('validation preparation re-checks health even when the lease already looks acquired', async (t) => {
  let healthy = true;
  const { reconciler, registry, actions } = await harness(t, {
    capabilities: [entry('browser')],
    runAction: (_slot, action) =>
      action.kind === 'slot-action' && action.actionId === 'browser.health' && !healthy
        ? { ok: false, detail: 'browser is not responding' }
        : { ok: true },
  });
  assert.equal((await acquire(registry, 'browser', 'run-a')).ok, true);
  const requirements = [{ capabilityId: 'browser', reason: 'validation', mode: 'visual' as const }];
  // First pass establishes `active`, so a second identical pass would otherwise
  // take the idempotent short-circuit.
  const first = await reconciler.apply({
    runId: 'run-a',
    posture: 'active',
    proofRequirements: requirements,
  });
  assert.equal(first.ok, true);

  healthy = false;
  actions.length = 0;
  const second = await reconciler.apply({
    runId: 'run-a',
    posture: 'active',
    proofRequirements: requirements,
  });
  assert.notEqual(second.transition.outcome, 'idempotent', 'health must be proven, not assumed');
  assert.equal(second.ok, false);
  assert.equal(second.transition.rejection?.kind, 'capability-unavailable');
  assert.ok(actions.includes('browser.health'), actions.join(', '));
});

test('a park that runs and reports failed is a rejection, not a parked run', async (t) => {
  const { reconciler, registry, runs } = await harness(t, {
    capabilities: [CATALOG_LINT],
    parkExecute: async (params) => ({
      ok: false,
      outcome: 'failed',
      operationId: params.operationId ?? 'op',
      machine: params.machine,
      mode: params.mode,
      records: [],
    }),
  });
  assert.equal((await acquire(registry, 'lint', 'run-a')).ok, true);
  await reconciler.apply({ runId: 'run-a', posture: 'operator-wait' });

  const result = await reconciler.apply({ runId: 'run-a', posture: 'parked' });
  assert.equal(result.ok, false);
  assert.equal(result.transition.outcome, 'rejected');
  assert.equal(result.transition.rejection?.kind, 'park-ineligible');
  assert.equal(result.status.posture, 'operator-wait');
  assert.equal(result.status.workerRetained, true);
  assert.equal(runs.get('run-a')?.resourcePosture?.posture, 'operator-wait');
});

test('operator-wait stops an expensive parent while its cheap dependency stays acquired', async (t) => {
  const { reconciler, registry, actions } = await harness(t, {
    capabilities: [
      entry('app', {
        dependencies: ['metro'],
        cost: { class: 'high', resources: [] },
      }),
      entry('metro', { cost: { class: 'low', resources: [] } }),
    ],
  });
  const acquired = await acquire(registry, 'app', 'run-a');
  assert.equal(acquired.ok, true);
  actions.length = 0;

  const result = await reconciler.apply({ runId: 'run-a', posture: 'operator-wait' });
  const byId = new Map(
    result.status.capabilities.map((state) => [state.capabilityId, state] as const),
  );
  // High cost with no keep-warm window is shed; the low-cost dependency is kept
  // so the next operator action stays usable.
  assert.equal(byId.get('app')?.desiredDisposition, 'stopped');
  assert.equal(byId.get('metro')?.desiredDisposition, 'acquired');
  assert.deepEqual(
    actions.filter((action) => action.endsWith('.release')),
    ['app.release'],
  );
  assert.equal(byId.get('metro')?.observedState, 'running');
});

test('terminal cleanup releases leases the reconciler could not see when it planned', async (t) => {
  // The live failure: cancel ran terminal cleanup while a dependent acquire was
  // in flight, so the leases that completed afterwards were never in the plan
  // and stayed acquired, holding a simulator and Metro for a dead run.
  const { reconciler, registry, actions } = await harness(t, {
    capabilities: [
      entry('ios-simulator', { dependencies: ['companion-metro'] }),
      entry('companion-metro'),
    ],
    hideLeasesOnFirstStatus: true,
  });
  assert.equal((await acquire(registry, 'ios-simulator', 'run-a')).ok, true);
  actions.length = 0;

  const result = await reconciler.apply({ runId: 'run-a', posture: 'terminal' });
  assert.equal(result.ok, true);
  const status = await registry.status({ slotId: SLOT });
  const held = status.leases.filter((lease) =>
    ['acquiring', 'acquired', 'releasing'].includes(lease.state),
  );
  assert.deepEqual(held, [], 'a terminal run must hold nothing, planned or not');
  assert.ok(actions.includes('ios-simulator.release'), actions.join(', '));
  assert.ok(actions.includes('companion-metro.release'), actions.join(', '));
});

test('a dependency inherits the strongest disposition of anything that depends on it', () => {
  // app is cheap and kept; metro is expensive and would be shed on its own.
  const policy = resolveEffectivePosturePolicy({
    posture: 'operator-wait',
    catalog: [
      entry('app', { dependencies: ['metro'], cost: { class: 'low', resources: [] } }),
      entry('metro', { cost: { class: 'high', resources: [] } }),
    ],
    proofRequirements: [],
    capabilityIds: ['app', 'metro'],
  });
  assert.equal(policy.perCapability.get('app')?.desired, 'acquired');
  assert.equal(
    policy.perCapability.get('metro')?.desired,
    'acquired',
    'shedding it would break the parent this posture keeps',
  );
  assert.match(policy.perCapability.get('metro')?.reason ?? '', /'app' depends on it/);
});

test('inheritance follows a whole dependency chain', () => {
  const policy = resolveEffectivePosturePolicy({
    posture: 'active',
    catalog: [
      entry('client', { dependencies: ['simulator'] }),
      entry('simulator', { dependencies: ['metro'], cost: { class: 'high', resources: [] } }),
      entry('metro', { cost: { class: 'high', resources: [] } }),
    ],
    proofRequirements: [{ capabilityId: 'client', reason: 'validation', mode: 'state' }],
    capabilityIds: ['client', 'simulator', 'metro'],
  });
  assert.equal(policy.perCapability.get('client')?.desired, 'acquired');
  assert.equal(policy.perCapability.get('simulator')?.desired, 'acquired');
  assert.equal(policy.perCapability.get('metro')?.desired, 'acquired');
});

test('a warm dependent keeps its dependency at least warm', () => {
  const policy = resolveEffectivePosturePolicy({
    posture: 'operator-wait',
    catalog: [
      entry('app', {
        dependencies: ['metro'],
        cost: { class: 'high', resources: [] },
        keepWarmMs: 1000,
      }),
      // Declares its own window, so `warm` is a state it can actually be in.
      entry('metro', { cost: { class: 'high', resources: [] }, keepWarmMs: 1000 }),
    ],
    proofRequirements: [],
    capabilityIds: ['app', 'metro'],
  });
  assert.equal(policy.perCapability.get('app')?.desired, 'warm');
  assert.equal(policy.perCapability.get('metro')?.desired, 'warm');
});

test('a lease the registry must retain is reported partial, never applied', async (t) => {
  // The registry refuses to release a lease something still depends on. However
  // that arises, the reconciler must not call it a success: the plan said stop
  // and the provider is still running. Driven through the registry response
  // because policy inheritance now prevents the run from planning this itself.
  const { reconciler, registry } = await harness(t, {
    capabilities: [entry('app', { dependencies: ['metro'] }), entry('metro')],
    retainOnRelease: ['metro'],
  });
  assert.equal((await acquire(registry, 'app', 'run-a')).ok, true);

  const result = await reconciler.apply({ runId: 'run-a', posture: 'terminal' });
  assert.equal(result.transition.outcome, 'partial');
  assert.equal(result.ok, false, 'a retained provider is not a successful stop');
  const failure = result.transition.failures.find((item) => item.capabilityId === 'metro');
  assert.ok(failure, JSON.stringify(result.transition.failures));
  assert.match(failure.reason, /still required by/);
});

test('a warm dependent retains a dependency that declares no keep-warm window', () => {
  const policy = resolveEffectivePosturePolicy({
    posture: 'operator-wait',
    catalog: [
      entry('app', {
        dependencies: ['metro'],
        cost: { class: 'high', resources: [] },
        keepWarmMs: 1000,
      }),
      // No keepWarmMs: releasing this stops it outright, so `warm` is not a
      // state it can be in.
      entry('metro', { cost: { class: 'high', resources: [] } }),
    ],
    proofRequirements: [],
    capabilityIds: ['app', 'metro'],
  });
  assert.equal(policy.perCapability.get('app')?.desired, 'warm');
  assert.equal(
    policy.perCapability.get('metro')?.desired,
    'acquired',
    'inheriting warm here would stop it under a dependent that stays warm',
  );
  assert.match(policy.perCapability.get('metro')?.reason ?? '', /no keep_warm_ms/);
});

test('operator-wait keeps a warm parent up by retaining its window-less dependency', async (t) => {
  const { reconciler, registry, actions } = await harness(t, {
    capabilities: [
      entry('app', {
        dependencies: ['metro'],
        cost: { class: 'high', resources: [] },
        keepWarmMs: 600_000,
      }),
      entry('metro', { cost: { class: 'high', resources: [] } }),
    ],
  });
  assert.equal((await acquire(registry, 'app', 'run-a')).ok, true);
  actions.length = 0;

  const result = await reconciler.apply({ runId: 'run-a', posture: 'operator-wait' });
  const byId = new Map(
    result.status.capabilities.map((state) => [state.capabilityId, state] as const),
  );
  assert.equal(byId.get('app')?.desiredDisposition, 'warm');
  assert.equal(byId.get('metro')?.desiredDisposition, 'acquired');
  assert.deepEqual(
    actions.filter((action) => action.endsWith('.release')),
    [],
    'nothing may be stopped under a provider this posture keeps warm',
  );
  assert.equal(byId.get('metro')?.observedState, 'running');
});

test('a stopped provider does not satisfy a warm desire', async (t) => {
  const { reconciler, registry } = await harness(t, {
    capabilities: [CATALOG_METRO],
  });
  assert.equal((await acquire(registry, 'metro', 'run-a')).ok, true);
  await reconciler.apply({ runId: 'run-a', posture: 'operator-wait' });
  // Force the warm provider down the way the keep-warm sweeper would.
  await registry.stopWarmProviders(SLOT, ['metro']);

  const repeat = await reconciler.apply({ runId: 'run-a', posture: 'operator-wait' });
  assert.notEqual(
    repeat.transition.outcome,
    'idempotent',
    'a stopped provider is not a cheaper way to be warm',
  );
  assert.equal(repeat.status.capabilities[0].observedState, 'stopped');
});

test('replaying an earlier operation id returns its result instead of re-executing', async (t) => {
  const { reconciler, registry, actions, runs } = await harness(t, {
    capabilities: [CATALOG_METRO],
  });
  assert.equal((await acquire(registry, 'metro', 'run-a')).ok, true);

  // A: operator-wait warms the provider.
  const a = await reconciler.apply({
    runId: 'run-a',
    posture: 'operator-wait',
    operationId: 'op-a',
  });
  assert.equal(a.transition.posture, 'operator-wait');

  // B: terminal stops it, overwriting lastTransition.
  const b = await reconciler.apply({ runId: 'run-a', posture: 'terminal', operationId: 'op-b' });
  assert.equal(b.transition.posture, 'terminal');
  assert.equal(runs.get('run-a')?.resourcePosture?.posture, 'terminal');

  // Retrying A must return A's stored result, not re-apply operator-wait and
  // undo B.
  actions.length = 0;
  const replayA = await reconciler.apply({
    runId: 'run-a',
    posture: 'operator-wait',
    operationId: 'op-a',
  });
  assert.equal(replayA.transition.id, 'op-a');
  assert.equal(replayA.transition.posture, 'operator-wait');
  assert.equal(replayA.transition.outcome, a.transition.outcome);
  assert.deepEqual(actions, [], 'a known operation id must never execute again');
  assert.equal(
    runs.get('run-a')?.resourcePosture?.posture,
    'terminal',
    'the later posture must survive the replay',
  );

  // Replaying B still works too.
  const replayB = await reconciler.apply({
    runId: 'run-a',
    posture: 'terminal',
    operationId: 'op-b',
  });
  assert.equal(replayB.transition.id, 'op-b');
  assert.deepEqual(actions, []);
});

test('operation history is bounded and keeps the newest ids', async (t) => {
  const { reconciler, registry } = await harness(t, { capabilities: [CATALOG_LINT] });
  assert.equal((await acquire(registry, 'lint', 'run-a')).ok, true);
  for (let index = 0; index < RESOURCE_POSTURE_TRANSITION_HISTORY + 5; index += 1) {
    await reconciler.apply({
      runId: 'run-a',
      posture: index % 2 === 0 ? 'operator-wait' : 'active',
      operationId: `op-${index}`,
    });
  }
  const history = runsHistory(reconciler, 'run-a');
  assert.equal(history.length, RESOURCE_POSTURE_TRANSITION_HISTORY);
  assert.equal(history[0].id, `op-${RESOURCE_POSTURE_TRANSITION_HISTORY + 4}`);
  assert.ok(
    !history.some((entry) => entry.id === 'op-0'),
    'the oldest ids fall out of the bounded window',
  );
});

test('preview for parked surfaces the park rejection instead of a plan that cannot run', async (t) => {
  const gateHeld = makeRun({ status: 'human-gating' });
  const { reconciler, registry, runs, parkCalls, actions } = await harness(t, {
    capabilities: [CATALOG_LINT],
    run: gateHeld,
    parkPreview: async (params) => ({
      previewId: 'preview-1',
      machine: params.machine,
      mode: params.mode,
      selector: params.selector,
      createdAt: '2026-09-05T00:00:00.000Z',
      runs: [
        {
          runId: 'run-a',
          generation: 1,
          selected: true,
          slotId: SLOT,
          status: 'human-gating',
          currentStep: null,
          slotDisposition: 'retained',
          eligibility: {
            eligible: false,
            code: 'STATUS_NOT_ELIGIBLE',
            reason: "status 'human-gating' is not monitoring or ci-watching",
          },
          recoveryPolicy: { kind: 'runner-session-reload', supported: false, runnerId: 'claude' },
          resourceManifest: {
            capturedAt: '2026-09-05T00:00:00.000Z',
            resources: [],
            capabilityLeases: [],
          },
        },
      ],
      eligibleCount: 0,
      rejectedCount: 1,
    }),
  });
  assert.equal((await acquire(registry, 'lint', 'run-a')).ok, true);
  // The gate-entry reconcile has already run, which is when an operator sees
  // the four choices, so the run is at an operator wait.
  await reconciler.apply({ runId: 'run-a', posture: 'operator-wait' });
  parkCalls.length = 0;
  actions.length = 0;

  const plan = await reconciler.preview({ runId: 'run-a', gateChoice: 'free-slot' });
  assert.equal(plan.posture, 'parked');
  assert.deepEqual(plan.rejection, {
    kind: 'park-ineligible',
    code: 'STATUS_NOT_ELIGIBLE',
    reason: "status 'human-gating' is not monitoring or ci-watching",
  });
  // Nothing to show the operator, because nothing would happen.
  assert.deepEqual(plan.acquire, []);
  assert.deepEqual(plan.retain, []);
  assert.deepEqual(plan.warm, []);
  assert.deepEqual(plan.stop, []);
  assert.deepEqual(plan.effects, []);
  // A preview mutates nothing: eligibility only, no execute, no provider action.
  assert.equal(parkCalls.length, 1);
  assert.deepEqual(actions, []);
  assert.equal(
    runs.get('run-a')?.resourcePosture?.posture,
    'operator-wait',
    'a preview must not move the run',
  );
  const status = await registry.status({ slotId: SLOT, ownerRunId: 'run-a' });
  assert.equal(status.leases[0]?.state, 'acquired');
});

test('preview for parked on an eligible run returns the plan', async (t) => {
  const { reconciler, registry, parkCalls } = await harness(t, {
    capabilities: [CATALOG_LINT],
  });
  assert.equal((await acquire(registry, 'lint', 'run-a')).ok, true);
  await reconciler.apply({ runId: 'run-a', posture: 'operator-wait' });
  parkCalls.length = 0;

  const plan = await reconciler.preview({ runId: 'run-a', gateChoice: 'free-slot' });
  assert.equal(plan.posture, 'parked');
  assert.equal(plan.rejection, undefined);
  assert.deepEqual(
    plan.stop.map((state) => state.capabilityId),
    ['lint'],
  );
  assert.equal(parkCalls.length, 1, 'eligibility is checked, execute is not called');
});

test('preview and apply agree on an already-parked run', async (t) => {
  const { reconciler, registry, parkCalls } = await harness(t, {
    capabilities: [CATALOG_LINT],
  });
  assert.equal((await acquire(registry, 'lint', 'run-a')).ok, true);
  await reconciler.apply({ runId: 'run-a', posture: 'operator-wait' });
  // Park it for real once.
  const parked = await reconciler.apply({ runId: 'run-a', gateChoice: 'free-slot' });
  assert.equal(parked.transition.outcome, 'applied');
  assert.equal(parked.status.posture, 'parked');
  // Real machine parking stops the manifest resources; the harness's parking
  // stub does not, so stop them here to reach the state a real park leaves.
  await registry.release({ slotId: SLOT, ownerRunId: 'run-a', keepWarm: false });
  parkCalls.length = 0;

  // Apply again: idempotent, and machine parking is never consulted.
  const repeatApply = await reconciler.apply({ runId: 'run-a', gateChoice: 'free-slot' });
  assert.equal(repeatApply.transition.outcome, 'idempotent');
  assert.equal(repeatApply.ok, true);
  assert.deepEqual(parkCalls, []);

  // Preview must say the same thing: no rejection, nothing to do.
  const plan = await reconciler.preview({ runId: 'run-a', gateChoice: 'free-slot' });
  assert.equal(plan.posture, 'parked');
  assert.equal(plan.rejection, undefined, 'an already-parked run is not ineligible');
  assert.deepEqual(plan.acquire, []);
  assert.deepEqual(plan.retain, []);
  assert.deepEqual(plan.warm, []);
  assert.deepEqual(plan.stop, []);
  assert.deepEqual(plan.effects, []);
  assert.match(plan.reason, /already parked/);
  assert.deepEqual(parkCalls, [], 'preview must not consult parking either');
});

test('a run whose park was restored can be parked again', async (t) => {
  // The persisted posture stays `parked` after a restore — it records the
  // policy that was applied, not where the run is now. Reading it as "already
  // parked" made `free-slot` at the next gate a silent no-op forever.
  const { reconciler, registry, runs, parkCalls } = await harness(t, {
    capabilities: [CATALOG_LINT],
  });
  assert.equal((await acquire(registry, 'lint', 'run-a')).ok, true);
  await reconciler.apply({ runId: 'run-a', posture: 'operator-wait' });
  assert.equal(
    (await reconciler.apply({ runId: 'run-a', gateChoice: 'free-slot' })).status.posture,
    'parked',
  );
  const restored = runs.get('run-a')!;
  restored.park = { ...restored.park!, phase: 'restored', restoredAt: '2026-09-05T01:00:00.000Z' };
  parkCalls.length = 0;

  const again = await reconciler.apply({ runId: 'run-a', gateChoice: 'free-slot' });

  assert.notEqual(again.transition.outcome, 'idempotent');
  assert.ok(parkCalls.length > 0, 'machine parking is consulted for a run that is not parked');
});

test('the reconciler folds a failed warm cleanup into the transition', async (t) => {
  // Driven through the sweep result: a real failure also leaves an error lease
  // that the terminal release re-reports, which would mask whether the summary
  // itself is being read.
  const { reconciler, registry } = await harness(t, {
    capabilities: [CATALOG_METRO],
    warmSweepResult: {
      released: [],
      deferred: [],
      failures: [{ capabilityId: 'metro', leaseId: 'lease-1', reason: 'metro shutdown exited 1' }],
      effects: [],
    },
  });
  assert.equal((await acquire(registry, 'metro', 'run-a')).ok, true);
  await reconciler.apply({ runId: 'run-a', posture: 'operator-wait' });

  const result = await reconciler.apply({ runId: 'run-a', posture: 'terminal' });
  assert.equal(result.transition.outcome, 'partial');
  assert.equal(result.ok, false, 'a warm provider that would not stop is not a success');
  const failure = result.transition.failures.find((item) => item.capabilityId === 'metro');
  assert.ok(failure, JSON.stringify(result.transition.failures));
  assert.match(failure.reason, /metro shutdown exited 1/);
});

test('the reconciler reports a deferred warm cleanup as still running', async (t) => {
  const { reconciler, registry } = await harness(t, {
    capabilities: [CATALOG_METRO],
    warmSweepResult: {
      released: [],
      deferred: [{ capabilityId: 'metro' }],
      failures: [],
      effects: [],
    },
  });
  assert.equal((await acquire(registry, 'metro', 'run-a')).ok, true);
  await reconciler.apply({ runId: 'run-a', posture: 'operator-wait' });

  const result = await reconciler.apply({ runId: 'run-a', posture: 'terminal' });
  const metro = result.status.capabilities.find((state) => state.capabilityId === 'metro');
  assert.equal(metro?.desiredDisposition, 'stopped');
  assert.equal(metro?.observedState, 'running', 'a deferred provider is demonstrably still up');
  assert.match(metro?.reason ?? '', /still needs it/);
  // Desired stopped while observed running is never a success.
  assert.equal(result.transition.outcome, 'partial');
  assert.equal(result.ok, false);
  const deferral = result.transition.failures.find((item) => item.capabilityId === 'metro');
  assert.ok(deferral, JSON.stringify(result.transition.failures));
  assert.match(deferral.reason, /still needs it/);
});

// ─── ADR-054 free-slot: admission is re-checked inside the per-run queue ───

test('a queued apply is admitted at execution time, not at enqueue time', async (t) => {
  const { reconciler, run } = await harness(t, { capabilities: [] });
  const order: string[] = [];
  let parked = false;
  let releaseFirst: () => void = () => {};
  const firstRunning = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  // First request occupies the queue. Its admission check is what the park
  // itself would pass through.
  const first = reconciler.apply({
    runId: run.id,
    posture: 'parked',
    assertAdmissible: () => {
      order.push('first-admitted');
      // Stand in for the park's own work: the queue is busy while this runs.
      parked = true;
    },
  });

  // Second request is enqueued NOW, while the run is not yet parked — the state
  // the RPC boundary would have validated against.
  const second = reconciler.apply({
    runId: run.id,
    posture: 'active',
    assertAdmissible: () => {
      order.push('second-admitted');
      if (parked) throw new Error('run is gate-parked');
    },
  });

  releaseFirst();
  await firstRunning;
  await first.catch(() => undefined);

  // Checked before the queue, this would have passed: the run was unparked when
  // it was enqueued. Checked inside, it sees the park the first request landed.
  await assert.rejects(second, /run is gate-parked/);
  assert.deepEqual(order, ['first-admitted', 'second-admitted']);
});

test('the inherited gate choice is resolved inside the per-run queue', async (t) => {
  const { reconciler, run } = await harness(t, { capabilities: [] });
  const resolvedAt: string[] = [];
  let releaseFirst: () => void = () => {};
  const firstRunning = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const first = reconciler.apply({
    runId: run.id,
    posture: 'parked',
    assertAdmissible: () => {
      resolvedAt.push('first-admitted');
    },
  });

  // Enqueued while the first request holds the queue. Resolving the inherited
  // choice out here would read the run BEFORE the first request's write; the
  // hook has to run inside the queue, after it.
  const second = reconciler.apply({
    runId: run.id,
    posture: 'operator-wait',
    resolveInheritedGateChoice: () => {
      resolvedAt.push('second-resolved');
      return 'keep-for-validation';
    },
  });

  releaseFirst();
  await firstRunning;
  await first.catch(() => undefined);
  await second.catch(() => undefined);

  // Ordering proves the hook ran inside the queue rather than at enqueue time.
  assert.deepEqual(resolvedAt, ['first-admitted', 'second-resolved']);
});

// ── ADR-054 item 3: re-target validation to another device ────────────────────

const CATALOG_DEVICE = entry('device', {
  cost: { class: 'high', resources: [{ id: 'the-device', access: 'exclusive', kind: 'device' }] },
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: { simulator: { type: 'string', pattern: '^[A-Za-z0-9._:-]+$' } },
  },
});

function acquireDevice(
  registry: RuntimeCapabilityRegistry,
  simulator: string,
  ownerRunId = 'run-a',
) {
  return registry.acquire({
    slotId: SLOT,
    capabilityId: 'device',
    ownerRunId,
    ownerFamilyId: 'fam-a',
    parameters: { simulator },
    proofRequirement: {
      capabilityId: 'device',
      reason: 'prove device',
      mode: 'state',
      parameters: { simulator },
    },
  });
}

test('validation preparation on a new device releases the old lease then acquires the new one', async (t) => {
  const { reconciler, registry, actionCalls } = await harness(t, {
    capabilities: [CATALOG_DEVICE],
  });
  assert.equal((await acquireDevice(registry, 'SIM-1')).ok, true);
  actionCalls.length = 0;

  const result = await reconciler.apply({
    runId: 'run-a',
    posture: 'active',
    proofRequirements: [
      {
        capabilityId: 'device',
        reason: 'validation',
        mode: 'state',
        parameters: { simulator: 'SIM-2' },
      },
    ],
  });
  assert.equal(result.ok, true);
  assert.equal(result.transition.outcome, 'applied');
  // Release before acquire, each against its own device: acquiring first would
  // conflict the run against itself on the exclusive device claim.
  assert.deepEqual(actionCalls, [
    { action: 'device.release', parameters: { simulator: 'SIM-1' } },
    { action: 'device.acquire', parameters: { simulator: 'SIM-2' } },
    { action: 'device.health', parameters: { simulator: 'SIM-2' } },
  ]);
  const leases = (await registry.status({ slotId: SLOT, ownerRunId: 'run-a' })).leases;
  assert.deepEqual(
    leases.filter((lease) => lease.state === 'acquired').map((lease) => lease.parameters),
    [{ simulator: 'SIM-2' }],
  );
  // Posture status reports the device the lease actually resolved to, which is
  // what Command Center and Companion render.
  const reported = await reconciler.status('run-a');
  assert.deepEqual(
    reported.state?.capabilities.find((capability) => capability.capabilityId === 'device')?.target,
    { simulator: 'SIM-2' },
  );
});

test('a re-target honours keep-warm: the warm provider is cleaned up before the new device boots', async (t) => {
  const warmDevice = { ...CATALOG_DEVICE, keepWarmMs: 600_000 };
  const { reconciler, actionCalls, registry } = await harness(t, { capabilities: [warmDevice] });
  assert.equal((await acquireDevice(registry, 'SIM-1')).ok, true);
  actionCalls.length = 0;

  const result = await reconciler.apply({
    runId: 'run-a',
    posture: 'active',
    proofRequirements: [
      {
        capabilityId: 'device',
        reason: 'validation',
        mode: 'state',
        parameters: { simulator: 'SIM-2' },
      },
    ],
  });
  assert.equal(result.ok, true);
  // The release honoured keep-warm, so no shutdown ran at release time. The
  // acquire then finds a warm provider for a DIFFERENT device and stops that one
  // — with SIM-1 — rather than leaving two simulators booted.
  assert.deepEqual(actionCalls, [
    { action: 'device.release', parameters: { simulator: 'SIM-1' } },
    { action: 'device.acquire', parameters: { simulator: 'SIM-2' } },
    { action: 'device.health', parameters: { simulator: 'SIM-2' } },
  ]);
});

test('re-targeting one run never touches another run device lease', async (t) => {
  const { reconciler, registry, actionCalls } = await harness(t, {
    capabilities: [CATALOG_METRO, CATALOG_DEVICE],
  });
  assert.equal((await acquire(registry, 'metro', 'other-run', 'fam-b')).ok, true);
  assert.equal((await acquireDevice(registry, 'SIM-1')).ok, true);
  actionCalls.length = 0;

  const result = await reconciler.apply({
    runId: 'run-a',
    posture: 'active',
    proofRequirements: [
      {
        capabilityId: 'device',
        reason: 'validation',
        mode: 'state',
        parameters: { simulator: 'SIM-2' },
      },
    ],
  });
  assert.equal(result.ok, true);
  assert.equal(
    actionCalls.some((call) => call.action.startsWith('metro.')),
    false,
    "another run's lease must not be touched by a re-target",
  );
  const other = await registry.status({ slotId: SLOT, ownerRunId: 'other-run' });
  assert.equal(other.leases[0]?.state, 'acquired');
});

test('a re-target whose old device will not stop is reported and blocks the new acquire', async (t) => {
  const { reconciler, registry } = await harness(t, {
    capabilities: [CATALOG_DEVICE],
    runAction: (_slotId, action) =>
      action.kind === 'slot-action' && action.actionId === 'device.release'
        ? { ok: false, detail: 'simctl shutdown failed' }
        : { ok: true },
  });
  assert.equal((await acquireDevice(registry, 'SIM-1')).ok, true);

  const result = await reconciler.apply({
    runId: 'run-a',
    posture: 'active',
    proofRequirements: [
      {
        capabilityId: 'device',
        reason: 'validation',
        mode: 'state',
        parameters: { simulator: 'SIM-2' },
      },
    ],
  });
  assert.equal(result.ok, false);
  assert.equal(result.transition.outcome, 'rejected');
  assert.match(
    result.transition.failures.map((failure) => failure.reason).join(' '),
    /re-target release failed: simctl shutdown failed/,
  );
  assert.equal(result.transition.rejection?.kind, 'capability-unavailable');
});

test('a requirement that only restates the platform does not reboot the same device', async (t) => {
  // `platform` selects which provider the target meant, not which device. The
  // proof-plan rewrite drops it for exactly this reason; this locks the
  // consequence, which is that no release or acquire action runs.
  const { reconciler, registry, actionCalls } = await harness(t, {
    capabilities: [CATALOG_DEVICE],
  });
  assert.equal((await acquireDevice(registry, 'SIM-1')).ok, true);
  actionCalls.length = 0;

  const result = await reconciler.apply({
    runId: 'run-a',
    posture: 'active',
    proofRequirements: [
      {
        capabilityId: 'device',
        reason: 'validation',
        mode: 'state',
        parameters: { simulator: 'SIM-1' },
      },
    ],
  });
  assert.equal(result.ok, true);
  assert.equal(
    actionCalls.some((call) => call.action === 'device.release'),
    false,
  );
});

test('re-applying the same device is not a re-target', async (t) => {
  const { reconciler, registry, actionCalls } = await harness(t, {
    capabilities: [CATALOG_DEVICE],
  });
  assert.equal((await acquireDevice(registry, 'SIM-1')).ok, true);
  actionCalls.length = 0;

  const result = await reconciler.apply({
    runId: 'run-a',
    posture: 'active',
    proofRequirements: [
      {
        capabilityId: 'device',
        reason: 'validation',
        mode: 'state',
        parameters: { simulator: 'SIM-1' },
      },
    ],
  });
  assert.equal(result.ok, true);
  assert.equal(
    actionCalls.some((call) => call.action === 'device.release'),
    false,
    'the same device must be revalidated in place, never released and rebooted',
  );
  assert.deepEqual(actionCalls, [{ action: 'device.health', parameters: { simulator: 'SIM-1' } }]);
});

test('a re-target reaches a device held as another capability dependency', async (t) => {
  // The shipped plan shape: `client` sorts before `device`, so the acquire loop
  // reaches the client first and pulls the device in as its dependency. Without
  // the whole plan's parameters, that dependency pinned the OLD device and the
  // device requirement was then refused for disagreeing with it.
  const client = entry('client', {
    cost: { class: 'high', resources: [] },
    dependencies: ['device'],
  });
  const { reconciler, registry, actionCalls } = await harness(t, {
    capabilities: [client, CATALOG_DEVICE],
  });
  assert.equal(
    (
      await registry.acquire({
        slotId: SLOT,
        capabilityId: 'client',
        ownerRunId: 'run-a',
        ownerFamilyId: 'fam-a',
        proofRequirement: { capabilityId: 'client', reason: 'prove client', mode: 'state' },
        dependencyParameters: { device: { simulator: 'SIM-1' } },
      })
    ).ok,
    true,
  );
  actionCalls.length = 0;

  const result = await reconciler.apply({
    runId: 'run-a',
    posture: 'active',
    proofRequirements: [
      { capabilityId: 'client', reason: 'validation', mode: 'state' },
      {
        capabilityId: 'device',
        reason: 'validation',
        mode: 'state',
        parameters: { simulator: 'SIM-2' },
      },
    ],
  });
  assert.equal(
    result.ok,
    true,
    JSON.stringify(result.transition.rejection ?? result.transition.failures),
  );
  const leases = (await registry.status({ slotId: SLOT, ownerRunId: 'run-a' })).leases;
  assert.deepEqual(
    leases
      .filter((lease) => lease.capabilityId === 'device' && lease.state === 'acquired')
      .map((lease) => lease.parameters),
    [{ simulator: 'SIM-2' }],
    'the dependency must land on the device the plan names, not the slot default',
  );
  assert.equal(
    actionCalls.some(
      (call) => call.action === 'device.acquire' && call.parameters.simulator === 'SIM-2',
    ),
    true,
  );
});

test('a fleet-scoped claim held elsewhere blocks with a typed wait the run keeps', async (t) => {
  const recording = entry('recording', {
    cost: {
      class: 'low',
      resources: [{ id: 'capture-helper', access: 'exclusive', kind: 'device', scope: 'fleet' }],
    },
  });
  const { reconciler, registry, runs } = await harness(t, { capabilities: [recording] });
  // The holder is on ANOTHER slot, which slot-scoped arbitration would ignore.
  const holder = await registry.acquire({
    slotId: 'slot-elsewhere',
    capabilityId: 'recording',
    ownerRunId: 'other-run',
    proofRequirement: { capabilityId: 'recording', reason: 'record', mode: 'state' },
  });
  assert.equal(holder.ok, true);

  const blocked = await reconciler.apply({
    runId: 'run-a',
    posture: 'active',
    proofRequirements: [{ capabilityId: 'recording', reason: 'validation', mode: 'state' }],
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.transition.outcome, 'rejected');
  const rejection = blocked.transition.rejection;
  assert.equal(rejection?.kind, 'capability-unavailable');
  if (rejection?.kind !== 'capability-unavailable') return;
  assert.equal(rejection.conflict.kind, 'scoped-wait');
  if (rejection.conflict.kind !== 'scoped-wait') return;
  assert.equal(rejection.conflict.claimId, 'capture-helper');
  assert.equal(rejection.conflict.owner.runId, 'other-run');
  assert.equal(rejection.conflict.position, 1);

  const wait = blocked.status.resourceWait;
  assert.equal(wait?.capabilityId, 'recording');
  assert.equal(wait?.claimId, 'capture-helper');
  assert.equal(wait?.scope, 'fleet');
  assert.equal(wait?.blockingOwner.runId, 'other-run');
  assert.equal(wait?.position, 1);
  assert.equal(wait?.queuedLeaseId, rejection.conflict.queuedLeaseId);
  assert.equal(runs.get('run-a')?.resourcePosture?.resourceWait?.claimId, 'capture-helper');

  // Once the holder is done the wait must not linger: a node reading this field
  // would otherwise report a running run as blocked forever.
  await registry.release({ slotId: 'slot-elsewhere', ownerRunId: 'other-run', keepWarm: false });
  const served = await reconciler.apply({
    runId: 'run-a',
    posture: 'active',
    proofRequirements: [{ capabilityId: 'recording', reason: 'validation', mode: 'state' }],
  });
  assert.equal(served.ok, true);
  assert.equal(served.status.resourceWait, undefined);
  assert.equal(runs.get('run-a')?.resourcePosture?.resourceWait, undefined);
});

test('a granted claim clears the run record the work-graph reads, with no second apply', async (t) => {
  const recording = entry('recording', {
    cost: {
      class: 'low',
      resources: [{ id: 'capture-helper', access: 'exclusive', kind: 'device', scope: 'fleet' }],
    },
  });
  const { reconciler, registry, runs } = await harness(t, { capabilities: [recording] });
  const holder = await registry.acquire({
    slotId: 'slot-elsewhere',
    capabilityId: 'recording',
    ownerRunId: 'other-run',
    proofRequirement: { capabilityId: 'recording', reason: 'record', mode: 'state' },
  });
  assert.equal(holder.ok, true);
  const requirements = [
    { capabilityId: 'recording', reason: 'validation', mode: 'state' as const },
  ];
  const blocked = await reconciler.apply({
    runId: 'run-a',
    posture: 'active',
    proofRequirements: requirements,
  });
  assert.equal(blocked.ok, false);
  assert.equal(runs.get('run-a')?.resourcePosture?.resourceWait?.claimId, 'capture-helper');

  // The holder releases. The drain reserves the claim, and the ONLY thing that
  // runs after it is the grant re-driving this run's own preparation — exactly
  // what the Gateway wires `onClaimGranted` to. No hand-written second apply.
  await registry.release({ slotId: 'slot-elsewhere', ownerRunId: 'other-run', keepWarm: false });
  const granted = await prepareRunPostureForValidation('run-a', requirements, reconciler);
  assert.equal(granted.ok, true);

  // The run record is what the work-graph projection reads. A stale wait here
  // is what pinned a granted node to `waiting` and stopped it dispatching.
  const persisted = runs.get('run-a')?.resourcePosture;
  assert.equal(persisted?.resourceWait, undefined);
  assert.equal(
    (await reconciler.status('run-a')).state.resourceWait,
    undefined,
    'the posture read re-derives the wait from the lease, not from an old transition',
  );
});

test('a scoped wait is reported as waiting, never as a preparation failure', async (t) => {
  const recording = entry('recording', {
    cost: {
      class: 'low',
      resources: [{ id: 'capture-helper', access: 'exclusive', kind: 'device', scope: 'fleet' }],
    },
  });
  const { reconciler, registry } = await harness(t, { capabilities: [recording] });
  assert.equal(
    (
      await registry.acquire({
        slotId: 'slot-elsewhere',
        capabilityId: 'recording',
        ownerRunId: 'other-run',
        proofRequirement: { capabilityId: 'recording', reason: 'record', mode: 'state' },
      })
    ).ok,
    true,
  );
  const outcome = await prepareRunPostureForValidation(
    'run-a',
    [{ capabilityId: 'recording', reason: 'validation', mode: 'state' }],
    reconciler,
  );
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  // The third answer: not success, not failure. A rerun that treated this as an
  // error ended for good and left its queue place with nothing to complete it.
  assert.equal(outcome.waiting, true);
  assert.match(outcome.reason, /queued behind 'capture-helper' at fleet scope/);
  assert.match(outcome.reason, /position 1/);
});

test('posture status stops reporting a wait as soon as the lease stops waiting', async (t) => {
  const recording = entry('recording', {
    cost: {
      class: 'low',
      resources: [{ id: 'capture-helper', access: 'exclusive', kind: 'device', scope: 'fleet' }],
    },
  });
  const { reconciler, registry } = await harness(t, { capabilities: [recording] });
  assert.equal(
    (
      await registry.acquire({
        slotId: 'slot-elsewhere',
        capabilityId: 'recording',
        ownerRunId: 'other-run',
        proofRequirement: { capabilityId: 'recording', reason: 'record', mode: 'state' },
      })
    ).ok,
    true,
  );
  const blocked = await reconciler.apply({
    runId: 'run-a',
    posture: 'active',
    proofRequirements: [{ capabilityId: 'recording', reason: 'validation', mode: 'state' }],
  });
  assert.equal(blocked.status.resourceWait?.claimId, 'capture-helper');

  // The holder releases and the drain reserves the claim. A client polling
  // status in the window before the grant's preparation finishes must not be
  // told the run is still in line — nothing writes a transition when a queue
  // drains, so a status that trusted the persisted copy would say it forever.
  // It is told the claim is GRANTED instead: still a wait, because no provider
  // has started, but nobody is ahead of it any more. Reporting nothing at all
  // is what made a reservation that never completed invisible on every surface.
  await registry.release({ slotId: 'slot-elsewhere', ownerRunId: 'other-run', keepWarm: false });
  const reserved = (await reconciler.status('run-a')).state.resourceWait;
  assert.equal(reserved?.phase, 'granted');
  assert.equal(reserved?.position, 0, 'a reservation is out of the queue, not at the front of it');
  assert.equal(reserved?.claimId, 'capture-helper');
  assert.match(reserved?.reason ?? '', /reserved for this run/);

  // And it clears the moment the completing acquire takes the lease over.
  assert.equal(
    (
      await prepareRunPostureForValidation(
        'run-a',
        [{ capabilityId: 'recording', reason: 'validation', mode: 'state' }],
        reconciler,
      )
    ).ok,
    true,
  );
  assert.equal((await reconciler.status('run-a')).state.resourceWait, undefined);
});

test('a reserved claim is completed before any other capability in the plan', async (t) => {
  // Sorts FIRST, so the plan's own order reaches it before the reservation.
  const device = entry('a-device', {
    cost: {
      class: 'low',
      resources: [{ id: 'a-claim', access: 'exclusive', kind: 'device', scope: 'fleet' }],
    },
  });
  const recording = entry('z-recording', {
    cost: {
      class: 'low',
      resources: [{ id: 'z-claim', access: 'exclusive', kind: 'device', scope: 'fleet' }],
    },
  });
  let deviceBroken = false;
  const { reconciler, registry } = await harness(t, {
    capabilities: [device, recording],
    runAction: (_slotId, action) => {
      const name = action.kind === 'slot-action' ? action.actionId : '';
      if (deviceBroken && (name === 'a-device.health' || name === 'a-device.acquire')) {
        return { ok: false, detail: 'the device fell over' };
      }
      return { ok: true };
    },
  });
  const requirements = [
    { capabilityId: 'a-device', reason: 'device', mode: 'visual' as const },
    { capabilityId: 'z-recording', reason: 'record', mode: 'state' as const },
  ];
  assert.equal(
    (
      await registry.acquire({
        slotId: 'slot-elsewhere',
        capabilityId: 'z-recording',
        ownerRunId: 'other-run',
        proofRequirement: { capabilityId: 'z-recording', reason: 'hold', mode: 'state' },
      })
    ).ok,
    true,
  );
  assert.equal(
    (await reconciler.apply({ runId: 'run-a', posture: 'active', proofRequirements: requirements }))
      .ok,
    false,
    'the run holds a-device and queues on z-claim',
  );

  // The holder releases, so the drain reserves z-claim for this run.
  await registry.release({ slotId: 'slot-elsewhere', ownerRunId: 'other-run', keepWarm: false });
  const reserved = (await registry.status({ slotId: SLOT })).leases.find(
    (lease) => lease.capabilityId === 'z-recording',
  );
  assert.equal(reserved?.state, 'acquiring');
  assert.equal(reserved?.wait?.kind, 'scoped-claim');

  // Now the OTHER capability in the same plan fails. Walking the plan in its own
  // order reached it first and returned, leaving the reservation `acquiring` —
  // a fleet claim held for a run with no provider behind it and nothing left to
  // complete it. The reservation goes first precisely so that cannot happen.
  deviceBroken = true;
  const completion = await reconciler.apply({
    runId: 'run-a',
    posture: 'active',
    proofRequirements: requirements,
  });
  assert.equal(completion.ok, false, 'a-device is genuinely broken');
  const after = (await registry.status({ slotId: SLOT })).leases.find(
    (lease) => lease.capabilityId === 'z-recording' && lease.state !== 'released',
  );
  assert.equal(after?.state, 'acquired', 'the reservation was completed before the failure');
  assert.equal(after?.wait, undefined, 'a completed reservation is no longer waiting');
});

test('a re-target queues before it releases, so the run never loses both devices', async (t) => {
  const simulator = entry('simulator', {
    cost: {
      class: 'low',
      resources: [{ id: 'sim-device', access: 'exclusive', kind: 'device', scope: 'fleet' }],
    },
    parameters: {
      type: 'object',
      properties: { simulator: { type: 'string' } },
    },
  });
  const helper = entry('helper', {
    cost: {
      class: 'low',
      resources: [{ id: 'capture-helper', access: 'exclusive', kind: 'device', scope: 'fleet' }],
    },
  });
  const { reconciler, registry, runs, actions } = await harness(t, {
    capabilities: [helper, simulator],
  });
  // The run holds SIM-1 for its own capability.
  assert.equal(
    (
      await reconciler.apply({
        runId: 'run-a',
        posture: 'active',
        proofRequirements: [
          {
            capabilityId: 'simulator',
            reason: 'device',
            mode: 'visual',
            parameters: { simulator: 'SIM-1' },
          },
        ],
      })
    ).ok,
    true,
  );
  // Another slot takes the fleet claim the re-targeted plan also needs.
  assert.equal(
    (
      await registry.acquire({
        slotId: 'slot-elsewhere',
        capabilityId: 'helper',
        ownerRunId: 'other-run',
        proofRequirement: { capabilityId: 'helper', reason: 'record', mode: 'state' },
      })
    ).ok,
    true,
  );
  actions.length = 0;

  const retarget = await reconciler.apply({
    runId: 'run-a',
    posture: 'active',
    proofRequirements: [
      {
        capabilityId: 'simulator',
        reason: 'device',
        mode: 'visual',
        parameters: { simulator: 'SIM-2' },
      },
      { capabilityId: 'helper', reason: 'record', mode: 'state' },
    ],
  });
  assert.equal(retarget.ok, false);
  const rejection = retarget.transition.rejection;
  assert.equal(rejection?.kind, 'capability-unavailable');
  if (rejection?.kind !== 'capability-unavailable') return;
  assert.equal(rejection.conflict.kind, 'scoped-wait');

  // The old device is untouched. Releasing it first left the run with neither
  // the device it had nor the one it asked for, and the recipe ran anyway.
  const held = (await registry.status({ slotId: SLOT })).leases.find(
    (lease) => lease.capabilityId === 'simulator',
  );
  assert.equal(held?.state, 'acquired');
  assert.deepEqual(held?.parameters, { simulator: 'SIM-1' });
  assert.deepEqual(actions, [], 'nothing was released or booted for a re-target that must wait');
  assert.equal(runs.get('run-a')?.resourcePosture?.resourceWait?.claimId, 'capture-helper');

  // Once the claim is free, the same request re-targets for real.
  await registry.release({ slotId: 'slot-elsewhere', ownerRunId: 'other-run', keepWarm: false });
  const completed = await reconciler.apply({
    runId: 'run-a',
    posture: 'active',
    proofRequirements: [
      {
        capabilityId: 'simulator',
        reason: 'device',
        mode: 'visual',
        parameters: { simulator: 'SIM-2' },
      },
      { capabilityId: 'helper', reason: 'record', mode: 'state' },
    ],
  });
  assert.equal(completed.ok, true);
  const retargeted = (await registry.status({ slotId: SLOT })).leases.filter(
    (lease) => lease.capabilityId === 'simulator' && lease.state === 'acquired',
  );
  assert.deepEqual(retargeted[0]?.parameters, { simulator: 'SIM-2' });
});

test("validation preparation keeps the operator's recorded gate choice", async (t) => {
  const browser = entry('browser');
  const { reconciler, runs } = await harness(t, { capabilities: [browser] });
  const gated = await reconciler.apply({
    runId: 'run-a',
    posture: 'operator-wait',
    gateChoice: 'keep-for-validation',
  });
  assert.equal(gated.status.gateChoice, 'keep-for-validation');

  // Validation preparation carries no gate choice — only a wait boundary
  // resolves one — and persisting without it erased the answer the operator had
  // already given. The Gateway completing a granted claim is the first path that
  // fires this with no operator in the loop at all.
  const prepared = await reconciler.apply({
    runId: 'run-a',
    posture: 'active',
    proofRequirements: [{ capabilityId: 'browser', reason: 'validation', mode: 'state' }],
  });
  assert.equal(prepared.ok, true);
  assert.equal(prepared.status.gateChoice, 'keep-for-validation');
  assert.equal(runs.get('run-a')?.resourcePosture?.gateChoice, 'keep-for-validation');
});
