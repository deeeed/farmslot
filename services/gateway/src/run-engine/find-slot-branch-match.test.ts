import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import type { Run, SlotStatus } from '@farmslot/protocol';

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
let prHead = branch;
const claims: string[] = [];
mock.module('../runs/store.js', {
  namedExports: {
    ...store,
    getRun: () => run,
    getAllRuns: () => [run],
    listRuns: () => ({ runs: [], totalCount: 0 }),
    persistRunNow: async () => {},
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
mock.module('../methods/dispatch.js', {
  namedExports: {
    ...scoring,
    resolveDispatchPreviewFromFleet: () => {
      throw new Error('unexpected dispatch queue');
    },
    refreshBranches: async () => {},
    collectBranchAffinityNudgeCandidates: async () => [],
    findAffinitySlot: () => null,
    selectBranchAffinityRefreshSlots: () => [],
    capturePressureAdmissionDecisionsLightweight: () => new Map(),
    consumedPressureAdmissionRef: () => {
      throw new Error('unexpected pressure override');
    },
    resolveExecutePressureOutcome: () => {
      throw new Error('unexpected pressure override');
    },
    prepareSlotForFreshReuse: () => {
      throw new Error('unexpected worker teardown');
    },
    verifyBranchAffinityNudgeStillEligible: () => {
      throw new Error('unexpected worker reuse');
    },
    PressureAdmissionRejectedError: class extends Error {},
    dispatchPreview: async (params: { targetBranch?: string }) => {
      assert.equal(params.targetBranch, branch);
      const selected = scoring.findBestSlot(slots, project, { targetBranch: params.targetBranch });
      assert.equal(selected?.slot, 'macpro-mmt-1');
      return { preview: { slotId: selected.slot, runner: 'codex', model: 'gpt-6.1-sol' } };
    },
  },
});
const policy = await import('./dispatch-policy.js');
const { executeFindSlotStep } = await import('./find-slot-step.js');

function reset(flowType: Run['flowType'], ticketOrPr: string): void {
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
  });
  claims.length = 0;
  prHead = branch;
}
const context: Parameters<typeof executeFindSlotStep>[3] = {
  ...policy,
  broadcastFn: () => {},
  setRunFlags: () => {},
  requiresCollisionPrecheck: () => false,
  handleCollisionDecision: async () => 'create-new',
  createEngineDecision: async () => {
    throw new Error('unexpected all_stale slot picker');
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
