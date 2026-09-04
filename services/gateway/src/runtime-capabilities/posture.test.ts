import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import type {
  MachinePauseExecuteParams,
  MachinePausePreviewParams,
  MachinePausePreviewResult,
  ProjectResourcePostureConfig,
  Run,
  RuntimeCapabilityCatalogEntry,
  RuntimeCapabilityProviderActionRef,
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
    capabilityStatus: (slotId) => registry.status({ slotId }),
    acquireCapability: (params) => registry.acquire(params),
    releaseForPosture: (slotId, dispositions) => registry.releaseForPosture(slotId, dispositions),
    machineForSlot: async () => MACHINE,
    parkPreview: async (params) => {
      parkCalls.push(params);
      return (options.parkPreview ?? defaultPreview)(params);
    },
    parkExecute: async (params) => {
      parkCalls.push(params);
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
