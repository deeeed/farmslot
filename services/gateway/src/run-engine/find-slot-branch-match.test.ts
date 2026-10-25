import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import type { PressureAdmissionDecision, Run, SlotStatus } from '@farmslot/protocol';

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
let expectedSlot = 'macpro-mmt-1';
const refreshedSlots: string[] = [];
let cancelledHolder: Run | undefined;
const originalSlots = structuredClone(slots);
const reclaims: string[] = [];
let prHead = branch;
const claims: string[] = [];
const finishedReclaims: string[] = [];
let finishedRefusal: string | undefined;
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
    loadProjectConfigs: async () => [{ name: project, defaultBranch: 'main' }],
    loadPoolConfigs: async () => [],
  },
});
const claim: typeof core.claimSlotStatusIf = async (id, predicate) => {
  assert.equal(predicate({ slot: id, lifecycle: 'ready', phase: null }), true);
  claims.push(id);
  return { claimed: true, epoch: 1 };
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
const { automaticSlotLoads } = await import('../methods/dispatch/pressure-admission.js');
mock.module('../methods/dispatch.js', {
  namedExports: {
    ...scoring,
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
    prepareSlotForFreshReuse: () => {
      throw new Error('unexpected worker teardown');
    },
    verifyBranchAffinityNudgeStillEligible: () => {
      throw new Error('unexpected worker reuse');
    },
    PressureAdmissionRejectedError: class extends Error {},
    dispatchPreview: async (
      params: import('@farmslot/protocol').DispatchPreviewParams,
      _options: object,
    ) => {
      if (!run.slotId) assert.equal(params.targetBranch, expectedTarget);
      const selected = run.slotId
        ? slots.find((slot) => slot.slot === run.slotId)
        : scoring.findBestSlot(slots, project, {
            ...params,
            automaticLoads: automaticSlotLoads(pressureDecisions),
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
const { executeFindSlotStep } = await import('./find-slot-step.js');

function reset(flowType: Run['flowType'], ticketOrPr: string): void {
  slots.splice(0, slots.length, ...structuredClone(originalSlots));
  cancelledHolder = undefined;
  reclaims.length = 0;
  finishedReclaims.length = 0;
  finishedRefusal = undefined;
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
  prHead = branch;
  pressureDecisions = new Map();
  expectedSlot = 'macpro-mmt-1';
  refreshedSlots.length = 0;
  nudgeCandidates = [];
  pickedSlot = undefined;
  expectedTarget = branch;
  pickerPayload = undefined;
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
test('an unresolved PR head still requires a slot choice when every free branch is stale', async () => {
  reset('pr-complete', 'example-org/terminal#210');
  prHead = '';
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

function loadDecision(machine: string, load1: number): PressureAdmissionDecision {
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
      samples: [{ collectedAt, cpu: 0.2, memory: 0.4, disk: 0.4, load1, critical: false }],
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
    ['macpro', loadDecision('macpro', 83 / 16)],
    ['macwork', loadDecision('macwork', 6 / 16)],
    ['mini', loadDecision('mini', 1.4 / 8)],
  ]);
  expectedSlot = 'macwork-mmt-1';
  run.allowedSlots = ['macpro-mmt-1', expectedSlot];
  const result = await executeFindSlotStep(run.id, run, 0, context);
  assert.equal(result.outputs?.selectedSlot, expectedSlot);
  assert.match(String(result.outputs?.selectionReason), /0.38 < 1.50/);
  assert.match(
    JSON.stringify(run.steps.find((step) => step.name === 'find-slot')?.inputs),
    /5.19 >= 1.50.*skipped/,
  );
  assert.deepEqual(refreshedSlots, [expectedSlot], 'do not probe overloaded or disallowed slots');
  assert.deepEqual(claims, [expectedSlot]);
  assert.equal(run.taskFile, null);
});

test('find-slot records why an all-overloaded allowlist cannot be selected', async () => {
  reset('fix-bug', 'TAT-4137');
  pressureDecisions = new Map([['macpro', loadDecision('macpro', 83 / 16)]]);
  run.allowedSlots = ['macpro-mmt-1'];
  await assert.rejects(
    executeFindSlotStep(run.id, run, 0, context),
    /No allowed free slot below.*5.19 >= 1.50/,
  );
  assert.match(
    JSON.stringify(run.steps.find((step) => step.name === 'find-slot')?.inputs),
    /skipped for automatic selection/,
  );
  assert.deepEqual(claims, []);
  assert.deepEqual(refreshedSlots, []);
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
    ['macpro', loadDecision('macpro', 83 / 16)],
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
  expectedTarget = undefined;
  const cold = candidate('cold', 'mini', 'fix/cold');
  const hot = candidate('hot', 'macpro', 'fix/hot');
  slots.splice(0, slots.length, cold, hot);
  pressureDecisions.set('mini', loadDecision('mini', 0.2));
  pressureDecisions.set('macpro', loadDecision('macpro', 6));
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
