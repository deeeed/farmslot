import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import * as promiseTimers from 'node:timers/promises';

import type {
  PoolConfig,
  PressureAdmissionDecision,
  ProjectSlotSelectionConfig,
  Run,
  SlotStatus,
} from '@farmslot/protocol';
import { sourceLockDigest } from '@farmslot/slot-config/sources';

import type { SafeIdleSlotResult } from '../run-lifecycle/safe-idle-slot.js';
import type { RunSlotSourcePlans } from '../sources/slot-planning.js';
import { sourceTestLock, sourceTestMaterialization } from '../sources/source.test-support.js';

await import('../runtime/mock-pty.test-support.js');
const { makeRun } = await import('./test-fixtures.js');
const store = await import('../runs/store.js');
const fleet = await import('../fleet/state.js');
const core = await import('../core/index.js');
const branches = await import('../methods/dispatch/branch-checkout.js');
const raw = await import('../methods/pr/raw-cache.js');

const project = 'example-terminal';
const branch = 'TAT-4137-feat-chart-native-order-management';
function candidate(slot: string, machine: string, slotBranch: string): SlotStatus {
  return {
    slot,
    machine,
    project,
    branch: slotBranch,
    platform: 'web',
    lifecycle: 'ready',
    agent: 'idle',
    enabled: true,
    dispatchable: true,
    phase: null,
    warm: true,
    health: { ssh: 'OK', device: '-', devserver: 'OK', cdp: 'OFF', fixtures: '4/8' },
    taskId: null,
    taskFile: null,
    dispatchedAt: null,
    completedAt: null,
    runner: null,
    model: null,
    deviceName: null,
    taskPhase: null,
    taskStepProgress: null,
  };
}
const slots: SlotStatus[] = [
  {
    ...candidate('macpro-mmt-1', 'macpro', branch),
    health: {
      ssh: 'OK',
      device: '-',
      devserver: 'OK',
      cdp: 'OFF',
      fixtures: '2/8',
    },
  },
  candidate('macpro-mmt-2', 'macpro', 'TAT-4129-feat-add-resizable-panels-layout'),
  {
    ...candidate('macwork-mmt-1', 'macwork', 'DEV-MANUAL-000146-implementation'),
    lifecycle: 'held',
  },
  ...['macwork-mmt-2', 'macwork-mmt-3'].map(
    (id): SlotStatus => ({
      ...candidate(id, 'macwork', '-'),
      lifecycle: 'disabled',
      enabled: false,
    }),
  ),
  {
    ...candidate('mini-mmt-1', 'mini', 'TAT-4125-feat-add-account-wide-position-orders'),
    hostLoad: { cpuPercent: 95, memoryPercent: 90, diskPercent: 50, headroom: 'red' },
  },
];
let run: Run;
let nudgeCandidates: import('../methods/dispatch/preview.js').BranchAffinityNudgeCandidate[] = [];
let pickedSlot: string | undefined;
let expectedTarget: string | undefined = branch;
let pickerPayload: import('@farmslot/protocol').RunDecisionPayload | undefined;
const liveRows = new Map<string, Record<string, unknown>>();
let pressureDecisions = new Map<string, PressureAdmissionDecision>();
const loadWaits: number[] = [];
let afterLoadWait: (() => void) | undefined;
mock.module('node:timers/promises', {
  namedExports: {
    ...promiseTimers,
    setTimeout: async (ms: number) => {
      loadWaits.push(ms);
      assert.ok(afterLoadWait, 'unexpected timer in slot selection');
      afterLoadWait();
    },
  },
});
let expectedSlot = 'macpro-mmt-1';
const refreshedSlots: string[] = [];
let cancelledHolder: Run | undefined;
const originalSlots = structuredClone(slots);
const reclaims: string[] = [];
let prHead = branch;
const claims: string[] = [];
const freshTeardowns: string[] = [];
let pools: PoolConfig[] = [];
let candidateSourcePlans: (() => RunSlotSourcePlans) | undefined;
const sourceAdmissions: string[] = [];
const finishedReclaims: string[] = [];
let finishedRefusal: string | undefined;
let slotSelection: ProjectSlotSelectionConfig | undefined;
mock.module('../runs/store.js', {
  namedExports: {
    ...store,
    getRun: (id: string) =>
      id === run.id ? run : cancelledHolder?.id === id ? cancelledHolder : undefined,
    getAllRuns: () => (cancelledHolder ? [run, cancelledHolder] : [run]),
    listRuns: () => ({ runs: [], totalCount: 0 }),
    persistRunNow: async () => {},
    updateRunStep: (
      _id: string,
      name: string,
      patch: Partial<import('@farmslot/protocol').RunStep>,
    ) => {
      const step = run.steps.find((step) => step.name === name);
      assert.ok(step);
      Object.assign(step, patch);
      return run;
    },
    updateRun: (_id: string, patch: Partial<Run>) => Object.assign(run, patch),
  },
});
mock.module('../fleet/state.js', {
  namedExports: {
    ...fleet,
    loadFleetStatus: async () => ({ slots }),
    loadProjectConfig: async () => null,
    loadProjectConfigs: async () => [{ name: project, defaultBranch: 'main', slotSelection }],
    loadPoolConfigs: async () => pools,
  },
});
const sourceRuntime = await import('../sources/runtime.js');
const withRunSources: typeof sourceRuntime.withRunSources = (current, operation, options) =>
  candidateSourcePlans ? operation() : sourceRuntime.withRunSources(current, operation, options);
mock.module('../sources/runtime.js', {
  namedExports: {
    ...sourceRuntime,
    planRunSourceSlots: (...args: Parameters<typeof sourceRuntime.planRunSourceSlots>) =>
      candidateSourcePlans
        ? Promise.resolve(candidateSourcePlans())
        : sourceRuntime.planRunSourceSlots(...args),
    admitRunSources: async (...args: Parameters<typeof sourceRuntime.admitRunSources>) => {
      if (!candidateSourcePlans) return sourceRuntime.admitRunSources(...args);
      assert.equal(args[0], run.id);
      assert.equal(args[1].slotId, expectedSlot);
      sourceAdmissions.push(args[1].nodeId);
    },
    withRunSources,
  },
});
const claim: typeof core.claimSlotStatusIf = async (id, predicate, fields) => {
  const row: Record<string, unknown> = {
    slot: id,
    lifecycle: 'ready',
    phase: null,
    ...liveRows.get(id),
  };
  assert.equal(predicate(row), true);
  claims.push(id);
  const epoch = (Number(row.slot_epoch) || 0) + 1;
  liveRows.set(id, { ...row, ...fields, slot_epoch: epoch });
  return { claimed: true, epoch };
};
mock.module('../core/index.js', {
  namedExports: {
    ...core,
    readSlotRow: async (id: string) => {
      const slot = slots.find((entry) => entry.slot === id);
      return slot
        ? {
            current_run_id: slot.currentRunId ?? null,
            lifecycle: slot.lifecycle,
            phase: slot.phase,
            ...liveRows.get(id),
          }
        : null;
    },
    claimSlotStatusIf: claim,
    updateSlotStatus: async () => {},
  },
});
mock.module('../methods/dispatch/branch-checkout.js', {
  namedExports: {
    ...branches,
    inspectReleasableBranchHolders: async () => new Set(),
    releaseBranchHolderForSelection: async () => {},
  },
});
mock.module('../methods/pr/raw-cache.js', {
  namedExports: {
    ...raw,
    getPRRawData: async (repo: string, number: number) => {
      assert.equal(repo, 'example-org/terminal');
      assert.equal(number, 210);
      return {
        checksStdout: '',
        prStateStdout: `OPEN\tfalse\tfalse\tfalse\t${prHead}`,
        commentsStdout: '',
        reviewCommentsStdout: '',
        latestCommitStdout: '',
        reviewMetaStdout: '',
        fetchedAt: Date.now(),
      };
    },
  },
});
const scoring = await import('../methods/dispatch/slot-scoring.js');
const { automaticSlotLoads, isPinnedSlotSelection } =
  await import('../methods/dispatch/pressure-admission.js');
let freshPreview = false;
mock.module('../methods/dispatch.js', {
  namedExports: {
    ...scoring,
    dispatchExecute: () => {
      throw new Error('unexpected worker dispatch');
    },
    nudgeDispatch: () => {
      throw new Error('unexpected nudge dispatch');
    },
    warmSessionHandoffDispatch: () => {
      throw new Error('unexpected warm dispatch');
    },
    resolveDispatchPreviewFromFleet: () => {
      throw new Error('unexpected dispatch queue');
    },
    refreshBranches: async (rows: SlotStatus[]) => {
      refreshedSlots.push(...rows.map((row) => row.slot));
    },
    collectBranchAffinityNudgeCandidates: async () => nudgeCandidates,
    findAffinitySlot: () => null,
    selectBranchAffinityRefreshSlots: () => [],
    capturePressureAdmissionDecisionsLightweight: () => pressureDecisions,
    consumedPressureAdmissionRef: () => {
      throw new Error('unexpected pressure override');
    },
    resolveExecutePressureOutcome: ({ decision }: { decision?: PressureAdmissionDecision }) => {
      assert.equal(decision?.state, 'disabled');
      return {};
    },
    prepareSlotForFreshReuse: async (id: string) => {
      assert.equal(run.engineState?.flags?.freshReuse, true);
      freshTeardowns.push(id);
    },
    verifyBranchAffinityNudgeStillEligible: () => {
      throw new Error('unexpected worker reuse');
    },
    PressureAdmissionRejectedError: class extends Error {},
    dispatchPreview: async (
      params: import('@farmslot/protocol').DispatchPreviewParams,
      options: Parameters<typeof import('../methods/dispatch/preview.js').dispatchPreview>[1],
    ) => {
      if (!run.slotId) assert.equal(params.targetBranch, expectedTarget);
      if (freshPreview)
        return resolveDispatchPreviewFromFleet(
          { ...params, runner: 'codex', model: 'gpt-6.1-sol' },
          slots,
          undefined,
          { pressureDecisions, automaticLoadPinned: options?.automaticLoadPinned },
        );
      const selected = run.slotId
        ? slots.find((slot) => slot.slot === run.slotId)
        : scoring.findBestSlot(slots, project, {
            ...params,
            automaticLoads: automaticSlotLoads(
              pressureDecisions,
              undefined,
              options?.automaticLoadPinned ?? isPinnedSlotSelection(params),
            ),
          });
      assert.equal(selected?.slot, expectedSlot);
      return {
        preview: { slotId: selected!.slot, runner: 'codex', model: 'gpt-6.1-sol' },
        pressureAdmission: pressureDecisions.get(selected!.machine),
      };
    },
  },
});
const policy = await import('./dispatch-policy.js');
const reclaim = await import('../run-lifecycle/cancelled-slot-reclaim.js');
mock.module('../run-lifecycle/cancelled-slot-reclaim.js', {
  namedExports: {
    ...reclaim,
    reclaimCancelledSlot: async (id: string, requester: string) => {
      const slot = slots.find((entry) => entry.slot === id);
      if (!slot?.currentRunId || slot.currentRunId !== cancelledHolder?.id) return false;
      assert.equal(requester, run.id);
      reclaims.push(id);
      slot.lifecycle = 'ready';
      slot.phase = null;
      slot.currentRunId = null;
      return true;
    },
  },
});
const finished = await import('../run-lifecycle/finished-slot-reclaim.js');
mock.module('../run-lifecycle/finished-slot-reclaim.js', {
  namedExports: {
    ...finished,
    reclaimFinishedSlot: async (slotId: string) => {
      assert.deepEqual(claims, [], 'cleanup must finish before the incoming claim');
      finishedReclaims.push(slotId);
      if (finishedRefusal) throw new Error(finishedRefusal);
    },
  },
});
const safeIdle = await import('../run-lifecycle/safe-idle-slot.js');
const reuseOutcomes = new Map<string, SafeIdleSlotResult>();
const reuseCalls: string[] = [];
let defaultReuseOutcome: SafeIdleSlotResult = { kind: 'ready' };
let afterReuse: ((slotId: string) => void) | undefined;
mock.module('../run-lifecycle/safe-idle-slot.js', {
  namedExports: {
    ...safeIdle,
    reuseSafeIdleSlot: async (slotId: string) => {
      reuseCalls.push(slotId);
      afterReuse?.(slotId);
      return reuseOutcomes.get(slotId) ?? defaultReuseOutcome;
    },
  },
});
const { resolveDispatchPreviewFromFleet } = await import('../methods/dispatch/preview.js');
const { executeFindSlotStep } = await import('./find-slot-step.js');

function reset(flowType: Run['flowType'], ticketOrPr: string): void {
  slots.splice(0, slots.length, ...structuredClone(originalSlots));
  cancelledHolder = undefined;
  reclaims.length = 0;
  finishedReclaims.length = 0;
  finishedRefusal = undefined;
  slotSelection = undefined;
  run = makeRun({
    id: 'branch-match-fixture',
    project,
    flowType,
    ticketOrPr,
    status: 'slot-finding',
    slotId: null,
    branch: '',
    lane: 'production',
    variant: null,
    engineState: { generation: 0 },
    steps: [{ name: 'find-slot', status: 'running' }],
  });
  claims.length = 0;
  freshTeardowns.length = 0;
  pools = [];
  candidateSourcePlans = undefined;
  sourceAdmissions.length = 0;
  prHead = branch;
  pressureDecisions = new Map();
  loadWaits.length = 0;
  afterLoadWait = undefined;
  expectedSlot = 'macpro-mmt-1';
  refreshedSlots.length = 0;
  nudgeCandidates = [];
  pickedSlot = undefined;
  expectedTarget = branch;
  pickerPayload = undefined;
  reuseOutcomes.clear();
  defaultReuseOutcome = { kind: 'ready' };
  reuseCalls.length = 0;
  freshPreview = false;
  afterReuse = undefined;
  liveRows.clear();
}
const context: Parameters<typeof executeFindSlotStep>[3] = {
  ...policy,
  broadcastFn: () => {},
  setRunFlags: () => {},
  requiresCollisionPrecheck: () => false,
  handleCollisionDecision: async () => 'create-new',
  createEngineDecision: async (_id, reason, _description, _actions, payload) => {
    pickerPayload = payload;
    assert.deepEqual(claims, [], 'the human decision must precede the slot claim');
    assert.deepEqual(finishedReclaims, [], 'stale checkout cleanup must wait for the human pick');
    if (!pickedSlot) throw new Error('unexpected all_stale slot picker');
    run.decisions.push({
      id: 'load-pick',
      type: `engine_${reason}`,
      title: 'Pick a slot',
      description: '',
      actions: [{ id: 'pick', label: 'Pick', style: 'primary' }],
      createdAt: new Date().toISOString(),
      resolvedAt: new Date().toISOString(),
      resolvedAction: 'pick',
      selectionData: { slotId: pickedSlot },
    });
    return 'pick';
  },
};
for (const [flow, ticket] of [
  ['pr-complete', 'example-org/terminal#210'],
  ['fix-bug', 'TAT-4137'],
] as const) {
  test(`find-slot auto-picks the matching ${flow} branch before task creation`, async () => {
    reset(flow, ticket);
    assert.deepEqual(
      slots.filter(scoring.isFreeSlot).map((slot) => scoring.slotScore(slot)),
      [61, 61, 161],
    );
    const result = await executeFindSlotStep(run.id, run, 0, context);
    assert.equal(result.outputs?.selectedSlot, 'macpro-mmt-1');
    assert.equal(result.outputs?.selectionMethod, 'scored');
    assert.deepEqual(result.outputs?.candidates, [
      { slotId: 'macpro-mmt-1', score: -89, cdpLive: false },
      { slotId: 'macpro-mmt-2', score: 61, cdpLive: false },
      { slotId: 'mini-mmt-1', score: 161, cdpLive: false },
    ]);
    assert.deepEqual(claims, ['macpro-mmt-1']);
  });
}
test('an unresolved PR head asks only when every free candidate has local work', async () => {
  reset('pr-complete', 'example-org/terminal#210');
  prHead = '';
  for (const slot of slots)
    reuseOutcomes.set(slot.slot, { kind: 'local-work', reason: 'dirty files' });
  await assert.rejects(
    executeFindSlotStep(run.id, run, 0, context),
    /unexpected all_stale slot picker/,
  );
  assert.deepEqual(claims, []);
});

for (const pinned of [true, false]) {
  test(`production find-slot reclaims a cancelled holder for a ${pinned ? 'pinned' : 'capacity-limited unpinned'} run`, async () => {
    reset('fix-bug', 'TAT-4137');
    const slot = slots[0]!;
    cancelledHolder = makeRun({
      id: 'cancelled-holder',
      project,
      slotId: slot.slot,
      status: 'cancelled',
    });
    slot.lifecycle = 'held';
    slot.phase = 'occupied';
    slot.currentRunId = cancelledHolder.id;
    run.allowedSlots = [slot.slot];
    if (pinned) run.slotId = slot.slot;
    const result = await executeFindSlotStep(run.id, run, 0, context);
    assert.equal(result.outputs?.selectedSlot, slot.slot);
    assert.deepEqual(reclaims, [slot.slot], 'one demand cleanup');
    assert.deepEqual(claims, [slot.slot], 'claim uses the post-cleanup fleet');
  });
}

test('a selected finished checkout is released before claim and write-task', async () => {
  reset('fix-bug', 'TAT-4137');
  run.slotId = slots[0]!.slot;
  slots[0]!.branch = 'fix/previous-finished-task';
  await executeFindSlotStep(run.id, run, 0, context);
  assert.deepEqual(finishedReclaims, [run.slotId]);
  assert.deepEqual(claims, [run.slotId]);
  assert.equal(run.taskFile, null, 'FIND_SLOT has not written the incoming task');
});

test('a refused finished checkout cleanup never claims the incoming run', async () => {
  reset('fix-bug', 'TAT-4137');
  run.slotId = slots[0]!.slot;
  finishedRefusal = 'UNMERGED_WORK:fix/previous:unpushed commit';
  await assert.rejects(executeFindSlotStep(run.id, run, 0, context), /UNMERGED_WORK/);
  assert.deepEqual(claims, []);
  assert.equal(run.taskFile, null);
});

test('skip-prepare retains its selected checkout without finished-run release', async () => {
  reset('fix-bug', 'TAT-4137');
  run.slotId = slots[0]!.slot;
  run.engineState = { generation: 0, flags: { skipPrepare: true } };
  await executeFindSlotStep(run.id, run, 0, context);
  assert.deepEqual(finishedReclaims, []);
  assert.deepEqual(claims, [run.slotId]);
});

function loadDecision(machine: string, cpu: number): PressureAdmissionDecision {
  const collectedAt = new Date().toISOString();
  return {
    outcome: 'admitted',
    machine,
    state: 'disabled',
    enforced: false,
    evidence: {
      machine,
      generation: 'current',
      evaluatedAt: collectedAt,
      samples: [{ collectedAt, cpu, memory: 0.4, disk: 0.4, load1: 2.11, critical: false }],
      consecutiveCriticalSamples: 0,
      requiredConsecutiveCriticalSamples: 3,
      staleAfterMs: 150000,
      latestSampleAt: collectedAt,
    },
  };
}

test('find-slot avoids overloaded allowed nodes and records the load decision before write-task', async () => {
  reset('fix-bug', 'TAT-4137');
  for (const row of slots) {
    row.branch = 'main';
    row.lifecycle = 'ready';
    row.agent = 'idle';
  }
  slots[0]!.branch = branch;
  pressureDecisions = new Map([
    ['macpro', loadDecision('macpro', 0.95)],
    ['macwork', loadDecision('macwork', 0.6)],
    ['mini', loadDecision('mini', 0.2)],
  ]);
  expectedSlot = 'macwork-mmt-1';
  run.allowedSlots = ['macpro-mmt-1', expectedSlot];
  const result = await executeFindSlotStep(run.id, run, 0, context);
  assert.equal(result.outputs?.selectedSlot, expectedSlot);
  assert.match(String(result.outputs?.selectionReason), /CPU idle 40\.00% >= 15\.00%/);
  assert.match(
    JSON.stringify(run.steps.find((step) => step.name === 'find-slot')?.inputs),
    /CPU idle 5\.00% < 15\.00%.*skipped/,
  );
  assert.deepEqual(refreshedSlots, [expectedSlot], 'do not probe overloaded or disallowed slots');
  assert.deepEqual(claims, [expectedSlot]);
  assert.equal(run.taskFile, null);
});

test('find-slot queues an all-overloaded allowlist until an allowed node cools', async (t) => {
  reset('fix-bug', 'TAT-4137');
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  pressureDecisions = new Map([['macpro', loadDecision('macpro', 0.95)]]);
  run.allowedSlots = ['macpro-mmt-1', 'macpro-mmt-2'];
  afterLoadWait = () => {
    const step = run.steps.find((step) => step.name === 'find-slot')!;
    assert.ok(step.queuedSince);
    assert.match(String(step.inputs?.hostLoadWaitReason), /CPU idle 5\.00% < 15\.00%/);
    assert.deepEqual(claims, []);
    assert.deepEqual(refreshedSlots, []);
    assert.equal(run.taskFile, null);
    now += 5_000;
    pressureDecisions.set('macpro', loadDecision('macpro', 0.4));
  };
  const result = await executeFindSlotStep(run.id, run, 0, context);
  assert.equal(result.outputs?.selectedSlot, 'macpro-mmt-1');
  assert.deepEqual(loadWaits, [5_000]);
  assert.deepEqual(claims, ['macpro-mmt-1']);
  assert.equal(run.steps[0]!.queuedMs, 5_000);
  assert.equal(run.steps[0]!.queuedSince, undefined);
});

for (const change of ['cancel', 'pause', 'replay'] as const) {
  test(`find-slot stops its load wait after ${change} without claiming a slot`, async () => {
    reset('fix-bug', 'TAT-4137');
    pressureDecisions = new Map([['macpro', loadDecision('macpro', 0.95)]]);
    run.allowedSlots = ['macpro-mmt-1', 'macpro-mmt-2'];
    afterLoadWait = () => {
      if (change === 'replay') run.engineState!.generation = 1;
      else run.status = change === 'cancel' ? 'cancelled' : 'paused';
    };
    await assert.rejects(executeFindSlotStep(run.id, run, 0, context), /changed while waiting/);
    assert.deepEqual(loadWaits, [5_000]);
    assert.deepEqual(claims, []);
    assert.deepEqual(refreshedSlots, []);
  });
}

test('find-slot wakes when a cool allowed slot becomes free while the original node stays hot', async () => {
  reset('fix-bug', 'TAT-4137');
  const newlyFree = slots[2]!;
  newlyFree.lifecycle = 'busy';
  newlyFree.agent = 'working';
  newlyFree.branch = 'main';
  pressureDecisions = new Map([
    ['macpro', loadDecision('macpro', 0.95)],
    ['macwork', loadDecision('macwork', 0.4)],
  ]);
  run.allowedSlots = [slots[0]!.slot, newlyFree.slot];
  expectedSlot = newlyFree.slot;
  afterLoadWait = () => {
    assert.equal(loadWaits.length, 1, 'selection must notice the newly free allowed capacity');
    assert.deepEqual(claims, []);
    newlyFree.lifecycle = 'ready';
    newlyFree.agent = 'idle';
  };
  const result = await executeFindSlotStep(run.id, run, 0, context);
  assert.equal(result.outputs?.selectedSlot, newlyFree.slot);
  assert.deepEqual(claims, [newlyFree.slot]);
  assert.deepEqual(loadWaits, [5_000]);
  assert.deepEqual(refreshedSlots, [newlyFree.slot]);
});

for (const alternateStaysCool of [true, false]) {
  test(`find-slot queues a final-preview load change and ${alternateStaysCool ? 'reselects a cool allowed slot' : 'waits until an allowed node cools'}`, async () => {
    reset('dev', 'TAT-3216');
    const first = slots[0]!;
    const alternate = slots[2]!;
    first.branch = alternate.branch = 'main';
    alternate.lifecycle = 'ready';
    alternate.agent = 'idle';
    run.allowedSlots = [first.slot, alternate.slot];
    expectedTarget = undefined;
    expectedSlot = alternateStaysCool ? alternate.slot : first.slot;
    freshPreview = true;
    pressureDecisions = new Map([
      [first.machine, loadDecision(first.machine, 0.2)],
      [alternate.machine, loadDecision(alternate.machine, 0.4)],
    ]);
    afterReuse = () => {
      afterReuse = undefined;
      // Safe reuse awaits remote checks; load may cross the limit before final preview.
      pressureDecisions.set(first.machine, loadDecision(first.machine, 0.95));
      if (!alternateStaysCool)
        pressureDecisions.set(alternate.machine, loadDecision(alternate.machine, 0.97));
    };
    afterLoadWait = () => {
      assert.equal(loadWaits.length, 1);
      assert.deepEqual(claims, [], 'overloaded selection must never claim a slot');
      if (!alternateStaysCool)
        pressureDecisions.set(first.machine, loadDecision(first.machine, 0.2));
    };
    const result = await executeFindSlotStep(run.id, run, 0, context);
    assert.equal(result.outputs?.selectedSlot, expectedSlot);
    assert.deepEqual(loadWaits, [5_000]);
    assert.deepEqual(reuseCalls, [first.slot, expectedSlot]);
    assert.deepEqual(claims, [expectedSlot]);
    assert.deepEqual(run.allowedSlots, [first.slot, alternate.slot]);
  });
}

test('find-slot replans a recovered same-ref source while the original node stays hot', async () => {
  reset('fix-bug', 'TAT-4137');
  const hot = slots[0]!;
  const cool = slots[2]!;
  cool.lifecycle = 'ready';
  cool.branch = 'main';
  run.allowedSlots = [hot.slot, cool.slot];
  expectedSlot = cool.slot;
  pressureDecisions = new Map([
    [hot.machine, loadDecision(hot.machine, 0.95)],
    [cool.machine, loadDecision(cool.machine, 0.4)],
  ]);
  const lockFor = (nodeId?: string) => {
    const { digest, ...content } = sourceTestLock(nodeId, run.id);
    const rebound = {
      ...content,
      context: { ...content.context, project },
      packBindings: { [project]: content.packBindings.demo! },
    };
    const lock = { ...rebound, digest: sourceLockDigest(rebound) };
    assert.notEqual(lock.digest, digest);
    return lock;
  };
  const lock = lockFor();
  run.sourcePlan = {
    state: 'planned',
    lock,
    workerLock: lock,
    bindings: [lock.packBindings[project]!],
  };
  const originalPlan = structuredClone(run.sourcePlan);
  let recovered = false;
  let plans = 0;
  candidateSourcePlans = () => {
    plans++;
    return new Map(
      [hot, cool].map((slot) => [
        slot.slot,
        slot === cool && !recovered
          ? { refusal: 'Source main is temporarily unavailable' }
          : {
              run,
              params: { project, flowType: run.flowType, ticketOrPr: run.ticketOrPr },
              sources: {
                project,
                pack: lock.packBindings[project]!,
                packs: lock.packBindings,
                materialization: sourceTestMaterialization(lockFor(slot.machine), 'gateway'),
              },
              projectConfigs: { [project]: { defaultBranch: 'main' } },
            },
      ]),
    );
  };
  pools = [hot, cool].map((slot) => ({
    machine: slot.machine,
    project,
    platform: 'web',
    os: 'test',
    host: slot.machine,
    sshUser: 'fixture',
    slots: [
      {
        id: slot.slot,
        enabled: true,
        mode: 'dispatch',
        project,
        repo: '/fixture/repo',
        session: slot.slot,
      },
    ],
  }));
  afterLoadWait = () => {
    assert.equal(loadWaits.length, 1, 'recovered source must be replanned on the next poll');
    assert.deepEqual(claims, []);
    recovered = true;
  };
  const result = await executeFindSlotStep(run.id, run, 0, context);
  assert.equal(result.outputs?.selectedSlot, cool.slot);
  assert.equal(plans, 2);
  assert.deepEqual(claims, [cool.slot]);
  assert.deepEqual(sourceAdmissions, [cool.machine]);
  assert.deepEqual(loadWaits, [5_000]);
  assert.deepEqual(
    run.sourcePlan,
    originalPlan,
    'recovery does not require selecting a new source',
  );
  assert.match(String(result.inputs?.hostLoadWaitReason), /CPU idle 5\.00% < 15\.00%/);
});

test('an operator affinity-card pick retains explicit pressure policy on an overloaded alternative', async () => {
  reset('pr-complete', 'example-org/terminal#210');
  const warm = slots[2]!;
  warm.lifecycle = 'busy';
  warm.agent = 'working';
  warm.branch = branch;
  const hot = slots[0]!;
  hot.branch = 'main';
  pressureDecisions = new Map([
    ['macpro', loadDecision('macpro', 0.95)],
    ['macwork', loadDecision('macwork', 0.4)],
  ]);
  pickedSlot = hot.slot;
  run.allowedSlots = [hot.slot, warm.slot];
  nudgeCandidates = [
    {
      slot: warm,
      uncommittedCount: 0,
      uncommittedFiles: [],
      nudgeCount: 0,
      ctxPct: null,
      prMatchKind: 'branch-slug',
      riskFlags: [],
      canNudge: false,
    },
  ];
  const result = await executeFindSlotStep(run.id, run, 0, context);
  assert.equal(result.outputs?.selectedSlot, hot.slot);
  assert.equal(result.outputs?.selectionMethod, 'human-override');
  assert.deepEqual(claims, [hot.slot]);
});

test('the stale-slot picker offers only eligible slots and waits for a human pick', async () => {
  reset('dev', 'TAT-9000');
  for (const slot of slots)
    reuseOutcomes.set(slot.slot, { kind: 'local-work', reason: 'dirty files' });
  defaultReuseOutcome = { kind: 'local-work', reason: 'dirty files' };
  expectedTarget = undefined;
  const selectable = candidate('selectable', 'macpro', 'fix/old');
  slots.splice(
    0,
    slots.length,
    selectable,
    { ...candidate('manual', 'macpro', 'HEAD'), lifecycle: 'manual' },
    { ...candidate('held', 'macpro', 'fix/held'), lifecycle: 'held' },
    { ...candidate('busy', 'macpro', 'fix/busy'), lifecycle: 'busy', agent: 'working' },
    { ...candidate('disabled', 'macpro', 'fix/disabled'), enabled: false },
    { ...candidate('ghost', 'macpro', 'fix/ghost'), missingFromPool: true },
    { ...candidate('repo-blocked', 'macpro', 'fix/blocked'), repoBlocker: 'operator root' },
    candidate('releasing', 'macpro', 'fix/releasing'),
    candidate('handoff', 'macpro', 'fix/handoff'),
    candidate('live-manual', 'macpro', 'fix/live-manual'),
    candidate('owned', 'macpro', 'fix/owned'),
  );
  liveRows.set('releasing', { phase: 'releasing' });
  liveRows.set('handoff', { handoff_run_id: 'other' });
  liveRows.set('live-manual', { lifecycle: 'manual' });
  liveRows.set('owned', { current_run_id: 'active-owner' });
  cancelledHolder = makeRun({ id: 'active-owner', slotId: 'owned', status: 'reviewing' });
  pressureDecisions.set('macpro', loadDecision('macpro', 0.2));
  expectedSlot = pickedSlot = selectable.slot;
  await executeFindSlotStep(run.id, run, 0, context);
  assert.equal(pickerPayload?.kind, 'slot_picker');
  if (pickerPayload?.kind !== 'slot_picker') throw new Error('Missing slot picker');
  assert.equal(pickerPayload.reason, 'all_stale');
  assert.deepEqual(
    pickerPayload.candidates.map((slot) => slot.slotId),
    [selectable.slot],
  );
  assert.equal(selectable.branch, 'fix/old', 'selection does not auto-reset the stale branch');
});

test('the stale-slot picker still permits an explicit node-load override', async () => {
  reset('dev', 'TAT-9000');
  for (const slot of slots)
    reuseOutcomes.set(slot.slot, { kind: 'local-work', reason: 'dirty files' });
  defaultReuseOutcome = { kind: 'local-work', reason: 'dirty files' };
  expectedTarget = undefined;
  const cold = candidate('cold', 'mini', 'fix/cold');
  const hot = candidate('hot', 'macpro', 'fix/hot');
  slots.splice(0, slots.length, cold, hot);
  pressureDecisions.set('mini', loadDecision('mini', 0.2));
  pressureDecisions.set('macpro', loadDecision('macpro', 0.95));
  expectedSlot = pickedSlot = hot.slot;
  await executeFindSlotStep(run.id, run, 0, context);
  assert.equal(pickerPayload?.kind, 'slot_picker');
  if (pickerPayload?.kind !== 'slot_picker') throw new Error('Missing slot picker');
  assert.deepEqual(
    pickerPayload.candidates.map((slot) => slot.slotId),
    [cold.slot, hot.slot],
  );
  assert.equal(hot.branch, 'fix/hot');
});

test('the picker offers a ready phone that on-request keeps from automatic selection', async () => {
  reset('dev', 'TAT-9004');
  expectedTarget = undefined;
  slotSelection = { physicalDevices: 'on-request' };
  const sim: SlotStatus = {
    ...candidate('sim', 'macwork', 'main'),
    lifecycle: 'busy',
    agent: 'working',
  };
  const phone: SlotStatus = {
    ...candidate('macpro-mm-pixel6', 'macpro', 'main'),
    platform: 'android',
    health: { ssh: 'OK', device: 'emu:OK', devserver: 'OK', cdp: 'OFF', fixtures: '4/8' },
    resources: { 'android-device': { adb_serial: '29071JEGR20638' } },
  };
  slots.splice(0, slots.length, sim, phone);
  pressureDecisions.set('macpro', loadDecision('macpro', 0.2));
  expectedSlot = pickedSlot = phone.slot;
  const result = await executeFindSlotStep(run.id, run, 0, context);
  if (pickerPayload?.kind !== 'slot_picker') throw new Error('Missing slot picker');
  assert.deepEqual(
    pickerPayload.candidates.map((s) => s.slotId),
    [phone.slot],
  );
  assert.equal(result.outputs?.selectedSlot, phone.slot);
  assert.equal(result.outputs?.selectionMethod, 'human-override');
  assert.deepEqual(claims, [phone.slot]);
});

test('the picker keeps released legacy rows without a phase eligible', async () => {
  reset('dev', 'TAT-9000');
  for (const slot of slots)
    reuseOutcomes.set(slot.slot, { kind: 'local-work', reason: 'dirty files' });
  defaultReuseOutcome = { kind: 'local-work', reason: 'dirty files' };
  expectedTarget = undefined;
  const legacy = candidate('legacy', 'macpro', 'fix/legacy');
  slots.splice(0, slots.length, legacy);
  liveRows.set(legacy.slot, { lifecycle: 'released', phase: undefined });
  pressureDecisions.set('macpro', loadDecision('macpro', 0.2));
  expectedSlot = pickedSlot = legacy.slot;
  await executeFindSlotStep(run.id, run, 0, context);
  if (pickerPayload?.kind !== 'slot_picker') throw new Error('Missing slot picker');
  assert.deepEqual(
    pickerPayload.candidates.map((s) => s.slotId),
    [legacy.slot],
  );
});

for (const reason of ['no_free_slots', 'missing_required_resources'] as const) {
  test(`the empty ${reason} picker gives an actionable message`, async () => {
    reset('dev', 'TAT-9000');
    expectedTarget = undefined;
    const slot = candidate('waiting', 'macpro', 'fix/old');
    if (reason === 'no_free_slots') slot.lifecycle = 'manual';
    else run.prepareProfile = 'companion-full';
    slots.splice(0, slots.length, slot);
    await assert.rejects(
      executeFindSlotStep(run.id, run, 0, {
        ...context,
        createEngineDecision: async (_id, _reason, description, _actions, payload) => {
          assert.equal(payload?.kind, 'slot_picker');
          if (payload?.kind !== 'slot_picker') throw new Error('Missing slot picker');
          assert.equal(payload.reason, reason);
          assert.deepEqual(payload.candidates, []);
          assert.match(description, /Abort and dispatch again/);
          assert.doesNotMatch(description, /listed/);
          assert.deepEqual(claims, []);
          assert.deepEqual(finishedReclaims, []);
          return 'abort';
        },
      }),
      /Aborted: no suitable slot/,
    );
  });
}

for (const kind of ['local-work', 'unavailable'] as const) {
  test(`automatic selection passes a ${kind} candidate and records its reason`, async () => {
    reset('dev', 'PROOF-9000');
    expectedTarget = undefined;
    const blocked = candidate('blocked', 'first', 'fix/published');
    const safe = candidate('safe', 'second', 'fix/merged');
    slots.splice(0, slots.length, blocked, safe);
    reuseOutcomes.set(blocked.slot, { kind, reason: 'candidate-specific refusal' });
    expectedSlot = safe.slot;
    const result = await executeFindSlotStep(run.id, run, 0, context);
    assert.equal(result.outputs?.selectedSlot, safe.slot);
    assert.deepEqual(reuseCalls, ['blocked', 'safe']);
    assert.deepEqual(result.inputs?.reclaimFailures, { blocked: 'candidate-specific refusal' });
    assert.equal(pickerPayload, undefined);
    assert.equal(run.allowedSlots, undefined);
  });
}

test('a clean main checkout is selected regardless of numeric stale score', async () => {
  reset('dev', 'PROOF-9001');
  expectedTarget = undefined;
  const safe = candidate('safe-main', 'first', 'main');
  safe.hostLoad = { cpuPercent: 95, memoryPercent: 90, diskPercent: 50, headroom: 'red' };
  slots.splice(0, slots.length, safe);
  assert.ok(scoring.slotScore(safe) >= 50, 'exercise the numeric stale-score threshold');
  expectedSlot = 'safe-main';
  const result = await executeFindSlotStep(run.id, run, 0, context);
  assert.equal(result.outputs?.selectedSlot, expectedSlot);
  assert.deepEqual(reuseCalls, [expectedSlot]);
  assert.equal(pickerPayload, undefined);
});

test('unknown evidence with no safe candidate refuses with reasons without a picker', async () => {
  reset('dev', 'PROOF-9002');
  slots.splice(0, slots.length, candidate('unreachable', 'first', 'main'));
  reuseOutcomes.set('unreachable', { kind: 'unavailable', reason: 'Git transport unavailable' });
  await assert.rejects(
    executeFindSlotStep(run.id, run, 0, context),
    /No safely reusable slot: unreachable: Git transport unavailable/,
  );
  assert.equal(pickerPayload, undefined);
  assert.deepEqual(claims, []);
});

test('an explicit wizard fresh dispatch records the CPU-idle bypass warning before returning', async () => {
  reset('dev', 'TAT-9003');
  expectedTarget = undefined;
  const selected = slots[0]!;
  selected.branch = 'main';
  run.slotId = selected.slot;
  run.allowedSlots = [selected.slot];
  run.engineState!.flags = { freshReuse: true };
  pressureDecisions.set(selected.machine, loadDecision(selected.machine, 0.95));
  const result = await executeFindSlotStep(run.id, run, 0, context);
  assert.equal(result.outputs?.via, 'wizard-fresh-reuse');
  assert.equal(result.outputs?.selectionMethod, 'human-override');
  assert.match(
    String(result.outputs?.selectionReason),
    /Warning:.*CPU idle 5\.00%.*explicitly pinned slot/,
  );
  assert.match(JSON.stringify(result.inputs?.hostLoadSelection), /"skipped":false/);
  assert.deepEqual(freshTeardowns, [selected.slot]);
  assert.deepEqual(loadWaits, []);
});
