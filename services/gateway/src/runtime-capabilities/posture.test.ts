import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import type {
  MachinePauseExecuteParams,
  MachinePauseExecuteResult,
  MachinePausePreviewParams,
  MachinePausePreviewResult,
  ProjectResourcePostureConfig,
  Run,
  RuntimeCapabilityCatalogEntry,
  RuntimeCapabilityProviderActionRef,
  RuntimeCapabilityReleaseResult,
} from '@farmslot/protocol';

import { resolveEffectivePosturePolicy, RunResourcePostureReconciler } from './posture.js';
import { RuntimeCapabilityRegistry } from './registry.js';
import { RuntimeCapabilityStore } from './store.js';

const SLOT = 'slot-a';
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
  ) => { ok: boolean; detail?: string };
  parkPreview?: (params: MachinePausePreviewParams) => Promise<MachinePausePreviewResult>;
  parkExecute?: (params: MachinePauseExecuteParams) => Promise<MachinePauseExecuteResult>;
  /** Simulate a status read taken while an acquire is still in flight. */
  hideLeasesOnFirstStatus?: boolean;
  /** Force the registry to report a lease it refused to release. */
  retainOnRelease?: string[];
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
    runAction: async (slotId, action) => {
      actions.push(
        action.kind === 'slot-action' ? action.actionId : `${action.resourceId}.${action.action}`,
      );
      return options.runAction?.(slotId, action) ?? { ok: true };
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
    releaseForPosture: async (slotId, dispositions) =>
      withForcedRetention(await registry.releaseForPosture(slotId, dispositions)),
    stopWarmProviders: (slotId, capabilityIds) => registry.stopWarmProviders(slotId, capabilityIds),
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
      return {
        ok: true,
        outcome: 'complete',
        operationId: params.operationId ?? 'op',
        machine: params.machine,
        mode: params.mode,
        records: [],
      };
    },
    onRunUpdated: (updated) => broadcasts.push(updated),
    now,
    newOperationId: () => 'op-generated',
  });

  return { registry, reconciler, actions, runs, broadcasts, parkCalls, storePath, directory };
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

test('a run with no slot is a typed invalid-request rejection that mutates nothing', async (t) => {
  const { reconciler, runs } = await harness(t, {
    capabilities: [CATALOG_LINT],
    run: makeRun({ slotId: null }),
  });
  const result = await reconciler.apply({ runId: 'run-a', posture: 'terminal' });
  assert.equal(result.ok, false);
  assert.equal(result.transition.rejection?.kind, 'invalid-request');
  assert.equal(runs.get('run-a')?.resourcePosture?.posture, undefined);
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

test('status reports running while a sibling family lease still holds the capability', async (t) => {
  const { reconciler, registry } = await harness(t, {
    capabilities: [entry('shared-db', { sharePolicy: 'shared' })],
  });
  assert.equal((await acquire(registry, 'shared-db', 'run-a')).ok, true);
  await reconciler.apply({ runId: 'run-a', posture: 'terminal' });
  // A sibling in the same family takes the capability after run-a finished with
  // it. The persisted terminal posture groups both leases together.
  assert.equal((await acquire(registry, 'shared-db', 'sibling-run')).ok, true);

  const status = await reconciler.status('run-a');
  const state = status.state.capabilities.find((item) => item.capabilityId === 'shared-db');
  assert.equal(
    state?.observedState,
    'running',
    'a sibling lease still holds the provider, so it is not stopped',
  );
  assert.equal(state?.owner?.runId, 'sibling-run');
});

test('a refused park keeps the posture the run actually had', async (t) => {
  const { reconciler, registry, runs, actions } = await harness(t, {
    capabilities: [CATALOG_LINT],
    // Preview accepts, then the execute refuses the way a stale preview does.
    parkExecute: async () => {
      throw new Error('machine pause preview is stale; preview the batch again');
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
