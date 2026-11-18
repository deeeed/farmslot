import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import type { Run } from '@farmslot/protocol';

import type { SlotVars } from '../core/config.js';

import { RETAINED_SESSION_HANDOFF_HOLD } from './errors.js';

await import('../runtime/mock-pty.test-support.js');
const config = await import('../core/config.js');
const slotBinding = await import('../runs/slot-binding.js');
const dispatch = await import('../methods/dispatch.js');
const state = await import('../core/state.js');
const monitors = await import('./run-monitor.js');
const capabilities = await import('./declared-capabilities.js');
const store = await import('../runs/store.js');
const { WorkerLaunchInputsChangedError } = await import('./worker-launch-preflight.js');
const { LaunchPreflightRefusal } = await import('./worker-preflight.js');
const { makeRun } = await import('./test-fixtures.js');

let current: Run;
let attempts = 0;
let outcomes: Error[] = [];
/** When set, the attempt after the scripted refusals launches. */
let launches = false;
let launchAttempted = false;
let priorWorker = false;
let supersedeClaim = false;
let warmSuccess = false;
let parent: Run | undefined;
let slotRow: Record<string, unknown> | undefined;
const partialIO: Parameters<typeof executeDispatchStep>[1]['stepPartialIO'] = new Map();
const stop = new Error('Stop after the dispatch attempt');
const vars: SlotVars = {
  slotId: 'fixture',
  host: 'localhost',
  machine: 'local',
  platform: 'cli',
  sshUser: 'test',
  osType: 'darwin',
  claudePath: '',
  codexPath: '',
  opencodePath: '',
  cursorPath: '',
  grokPath: '',
  dispatchCmd: '',
  recycleCmd: '',
  repo: '/fixture',
  remoteRepo: '/fixture',
  session: 'fixture',
  slotMode: 'dispatch',
  slotEnabled: true,
  sshTarget: 'localhost',
  projectName: 'example',
  resourceVars: {},
};
mock.module('../core/config.js', { namedExports: { ...config, loadSlotVars: async () => vars } });
mock.module('../runs/slot-binding.js', {
  namedExports: { ...slotBinding, ensureRunSlotBinding: () => current },
});
mock.module('../core/state.js', {
  namedExports: {
    ...state,
    readSlotRow: async () => slotRow,
    claimSlotStatusIf: async (
      _slotId: string,
      predicate: (row: Readonly<Record<string, unknown>>) => boolean,
      fields: Record<string, unknown>,
    ) => {
      if (supersedeClaim) current.engineState = { ...current.engineState, generation: 1 };
      if (!slotRow || !predicate(slotRow)) return { claimed: false, epoch: null };
      Object.assign(slotRow, fields, { slot_epoch: Number(slotRow.slot_epoch) + 1 });
      return { claimed: true, epoch: Number(slotRow.slot_epoch) };
    },
  },
});
mock.module('./run-monitor.js', {
  namedExports: { ...monitors, prepareWarmBudgetBaselineForHandoff: async () => 'ready' },
});
mock.module('./declared-capabilities.js', {
  namedExports: { ...capabilities, prepareConfiguredRunCapabilities: async () => {} },
});
mock.module('../run-completion/inherited-acceptance.js', {
  namedExports: { stageInheritedAcceptance: async () => {} },
});
mock.module('../methods/dispatch.js', {
  namedExports: {
    ...dispatch,
    warmSessionHandoffDispatch: async () =>
      warmSuccess
        ? { handedOff: true, runner: 'scripted' }
        : { handedOff: false, disposition: 'fresh-dispatch', reason: 'worker session not alive' },
    dispatchExecute: async (...args: Parameters<typeof dispatch.dispatchExecute>) => {
      attempts++;
      if (slotRow)
        assert.equal(
          slotRow.current_run_id,
          current.id,
          'fresh launch preflight requires the child owner',
        );
      if (launchAttempted) args[2]?.onLaunchAttempt?.();
      const refusal = outcomes.shift();
      if (refusal || !launches) throw refusal ?? stop;
      return { launchCommand: 'fixture-launch' };
    },
  },
});
mock.module('../runs/store.js', {
  namedExports: {
    ...store,
    getRun: (id: string) =>
      id === current?.id ? current : id === parent?.id ? parent : store.getRun(id),
    updateRun: (_id: string, patch: Partial<Run>) => Object.assign(current, patch),
  },
});
const freshModule: string = './dispatch-lifecycle-steps.js?launch-inputs-retry';
const { executeDispatchStep } = (await import(
  freshModule
)) as typeof import('./dispatch-lifecycle-steps.js');

const dispatchOnce = () => {
  partialIO.clear();
  current = makeRun({
    id: `launch-inputs-${attempts}`,
    flowType: 'dev',
    slotId: vars.slotId,
    taskFile: '/tasks/dev/TASK.md',
    engineState: { flags: { skipPrepare: true } },
  });
  if (priorWorker) current.metrics.runnerSessionId = 'existing-worker';
  return executeDispatchStep(current.id, {
    stepPartialIO: partialIO,
    blockedRunError: (message) => new Error(message),
  });
};

test('a launch whose configured inputs changed during preflight is dispatched once more', async () => {
  // F296: the 0.94.9 pool rewrite landed during two live preflights, which refused (nothing
  // launched). The engine re-reads the inputs and checks again instead of failing the run.
  attempts = 0;
  outcomes = [new WorkerLaunchInputsChangedError('Worker launch inputs changed during preflight')];
  await assert.rejects(dispatchOnce(), (error) => error === stop);
  assert.equal(attempts, 2, 'the second attempt re-reads and dispatches');
});

test('pre-launch failures retain their explicit phase through partial dispatch output', async () => {
  attempts = 0;
  outcomes = [];
  await assert.rejects(dispatchOnce(), (error) => error === stop);
  assert.equal(partialIO.get(current.id)?.outputs?.failedPhase, 'before-worker-launch');
});

test('an attempted launch clears pre-worker classification before a later failure', async () => {
  attempts = 0;
  outcomes = [];
  launchAttempted = true;
  try {
    await assert.rejects(dispatchOnce(), (error) => error === stop);
    assert.equal(partialIO.get(current.id)?.outputs?.failedPhase, 'worker-launch');
  } finally {
    launchAttempted = false;
  }
});

test('a replay with prior execution never enters a fresh pre-worker phase', async () => {
  attempts = 0;
  outcomes = [];
  priorWorker = true;
  try {
    await assert.rejects(dispatchOnce(), (error) => error === stop);
    assert.equal(partialIO.get(current.id)?.outputs?.failedPhase, 'worker-launch');
  } finally {
    priorWorker = false;
  }
});

test('the retried dispatch launches and its sub-steps record the retry', async () => {
  attempts = 0;
  launches = true;
  outcomes = [new WorkerLaunchInputsChangedError('Worker launch inputs changed during preflight')];
  try {
    const { outputs } = await dispatchOnce();
    assert.ok(outputs);
    assert.equal(attempts, 2);
    assert.equal(outputs.launchCommand, 'fixture-launch');
    assert.deepEqual(
      (outputs.subSteps as Array<{ name: string }>).map((step) => step.name),
      ['preflight-retry'],
    );
  } finally {
    launches = false;
  }
});

test('any other refusal gets no second attempt', async () => {
  for (const refusal of [
    new Error('Worker launch inputs changed during preflight; superseded'),
    new LaunchPreflightRefusal('code', 'the slot checkout is not the dispatched commit'),
  ]) {
    attempts = 0;
    outcomes = [refusal];
    await assert.rejects(dispatchOnce(), (error) => error === refusal);
    assert.equal(attempts, 1, refusal.message);
  }
});

test('a second change in a row still refuses', async () => {
  attempts = 0;
  outcomes = [
    new WorkerLaunchInputsChangedError('Worker launch inputs changed during preflight'),
    new WorkerLaunchInputsChangedError('Worker launch inputs changed during preflight'),
  ];
  await assert.rejects(dispatchOnce(), WorkerLaunchInputsChangedError);
  assert.equal(attempts, 2);
});

for (const scenario of [
  'reserved parent',
  'stale devserver epoch',
  'warm handoff succeeds',
  'other owner',
  'other reservation',
  'already owned with another reservation',
  'releasing slot',
  'cleanup owner',
  'disabled slot',
  'manual slot',
  'superseded before claim',
  'active parent',
] as const) {
  test(`fresh dispatch after warm fallback respects the slot claim: ${scenario}`, async () => {
    attempts = 0;
    launches = true;
    outcomes = [];
    parent = makeRun({
      id: 'parent',
      status: scenario === 'active parent' ? 'ci-watching' : 'done',
      slotId: vars.slotId,
    });
    current = makeRun({
      id: 'ci-child',
      status: 'dispatching',
      flowType: 'pr-complete',
      parentRunId: parent.id,
      slotId: vars.slotId,
      taskFile: '/tasks/child/TASK.md',
      metrics: { ...parent.metrics, runner: 'scripted' },
      engineState: { flags: { skipPrepare: true, warmSessionReuse: true } },
    });
    const owner =
      scenario === 'other owner'
        ? 'sibling'
        : scenario === 'already owned with another reservation'
          ? current.id
          : parent.id;
    const reservation =
      scenario === 'other reservation' || scenario === 'already owned with another reservation'
        ? 'sibling'
        : current.id;
    const idleEpoch = scenario === 'stale devserver epoch' ? 6 : 7;
    supersedeClaim = scenario === 'superseded before claim';
    warmSuccess = scenario === 'warm handoff succeeds';
    slotRow = {
      current_run_id: owner,
      handoff_run_id: reservation,
      slot_epoch: 7,
      lifecycle:
        scenario === 'disabled slot' ? 'disabled' : scenario === 'manual slot' ? 'manual' : 'busy',
      phase: scenario === 'releasing slot' ? 'releasing' : 'working',
      ...(scenario === 'cleanup owner' ? { cleanup_run_id: parent.id } : {}),
      idle_devserver_epoch: idleEpoch,
      idle_devservers: ['test-fixture'],
    };
    try {
      const work = executeDispatchStep(current.id, {
        stepPartialIO: partialIO,
        blockedRunError: (message, detail) => Object.assign(new Error(message), { detail }),
      });
      if (scenario === 'reserved parent' || scenario === 'stale devserver epoch') {
        assert.equal((await work).outputs?.success, true);
        assert.equal(attempts, 1);
        assert.equal(slotRow.current_run_id, current.id);
        assert.equal(slotRow.handoff_run_id, null);
        assert.equal(slotRow.slot_epoch, 8);
        assert.equal(slotRow.idle_devserver_epoch, idleEpoch === 7 ? 8 : idleEpoch);
      } else {
        if (warmSuccess) assert.equal((await work).outputs?.warmHandoff, true);
        else await assert.rejects(work, { detail: RETAINED_SESSION_HANDOFF_HOLD });
        assert.equal(attempts, 0);
        assert.equal(slotRow.current_run_id, owner);
        assert.equal(slotRow.handoff_run_id, reservation);
        assert.equal(slotRow.slot_epoch, 7);
      }
    } finally {
      launches = false;
      supersedeClaim = false;
      warmSuccess = false;
      parent = undefined;
      slotRow = undefined;
    }
  });
}
