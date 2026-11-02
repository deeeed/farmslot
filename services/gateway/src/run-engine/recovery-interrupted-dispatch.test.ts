// F331: a restart mid-DISPATCH adopts a worker holding its task instead of relaunching it.
import assert from 'node:assert/strict';
import test from 'node:test';

import { type AgentContext, FLOW_STEPS, type Run, type RunStep } from '@farmslot/protocol';

import '../runtime/mock-pty.test-support.js';

import { recoverActiveRuns, type RunRecoveryCollaborators } from './recovery.js';
import { makeRun } from './test-fixtures.js';

const DISPATCH_STARTED_AT = '2026-11-02T14:03:50.687Z';
const PROMPT_SENT_AT = '2026-11-02T14:03:52.000Z';
const OLDER_ATTEMPT_AT = '2026-11-02T13:00:00.000Z';

const unexpected = (): never => {
  throw new Error('unexpected recovery call');
};

interface Restart {
  run: Run;
  started: string[];
  slotWrites: Array<Record<string, unknown>>;
}

function restartAt(
  run: Run,
  { workerAlive = true, slotAgent = 'idle' }: { workerAlive?: boolean; slotAgent?: string } = {},
): { restart: Restart; deps: RunRecoveryCollaborators } {
  const restart: Restart = { run, started: [], slotWrites: [] };
  const deps: RunRecoveryCollaborators = {
    listRuns: () => ({ runs: [run] }),
    loadFleetStatus: async () => ({
      slots: [{ slot: run.slotId!, lifecycle: 'busy', phase: 'dispatching', agent: slotAgent }],
    }),
    isTerminalTeardownInFlight: () => false,
    readSlotField: async () => null,
    getRun: () => run,
    updateRun: (_runId: string, fields: Partial<Run>) => Object.assign(run, fields),
    stopRunOwnedWorkers: unexpected,
    updateRunStep: (_runId: string, name: string, fields: Partial<RunStep>) =>
      Object.assign(run.steps.find((step) => step.name === name)!, fields),
    broadcast: () => {},
    copyWorkerArtifacts: unexpected,
    readReviewArtifacts: unexpected,
    loadProjectVarsOrNull: unexpected,
    retainedRunArtifactManifest: unexpected,
    readTaskArtifactText: unexpected,
    setPrHealthOverlay: unexpected,
    buildCIWatchChainedRunParams: unexpected,
    createRun: unexpected,
    applyChainedRunEngineFlags: unexpected,
    startRun: async (runId: string) => {
      restart.started.push(runId);
    },
    reconstructStepOutputs: unexpected,
    loadSlotVars: unexpected,
    getProjectFieldRaw: unexpected,
    expandTemplate: unexpected,
    clearStalePrepareProcess: unexpected,
    expandHook: unexpected,
    execOnSlot: unexpected,
    getProjectField: unexpected,
    setRunFlags: unexpected,
    resetSlot: unexpected,
    retryOccupiedRunSlot: unexpected,
    resumeInterruptedRecovery: unexpected,
    resetSlotIf: unexpected,
    updateSlotStatusIf: async (_slotId, predicate, fields) => {
      if (!predicate({ current_run_id: run.id })) return false;
      restart.slotWrites.push(fields);
      return true;
    },
    quarantineLeakedRun: async () => {},
    // The real reconciliation probes the pane: live promotes a launching worker, dead blocks it.
    reconcileRunAgentRuntime: async (current) => {
      for (const context of current.agentContexts ?? [])
        context.status = workerAlive ? 'working' : 'blocked';
    },
    rearmHandoffAutoRecovery: unexpected,
    rearmPublicationReviewRecovery: unexpected,
    recoverInflightPublicationReviews: unexpected,
    replayHumanGate: unexpected,
    resumeHeldPublicationGate: unexpected,
  };
  return { restart, deps };
}

function dispatchingRun(runner: string, promptDeliveryStartedAt?: string): Run {
  const steps = FLOW_STEPS['fix-bug'];
  const worker: AgentContext = {
    id: 'fix-bug',
    role: 'fix-bug',
    label: 'Worker',
    status: 'launching',
    slotId: 'ri-pipe-2',
    runId: 'run-f331',
    runner,
    ...(promptDeliveryStartedAt ? { promptDeliveryStartedAt } : {}),
  };
  const run = makeRun({
    id: 'run-f331',
    flowType: 'fix-bug',
    lane: 'production',
    status: 'dispatching',
    slotId: 'ri-pipe-2',
    taskFile: '/projects/ri-pipe/tasks/f331/TASK.md',
    steps: steps.map((name, index) => {
      if (name === 'dispatch') return { name, status: 'running', startedAt: DISPATCH_STARTED_AT };
      return { name, status: index < steps.indexOf('dispatch') ? 'done' : 'pending' };
    }),
  });
  return { ...run, agentContexts: [worker] };
}

const stepStatus = (run: Run, name: string) => run.steps.find((step) => step.name === name)?.status;

test('restart adopts a live worker whose launch carried its prompt and resumes at MONITOR', async () => {
  for (const runner of ['scripted', 'pi', 'opencode']) {
    const { restart, deps } = restartAt(dispatchingRun(runner, PROMPT_SENT_AT));

    await recoverActiveRuns(deps);

    assert.equal(stepStatus(restart.run, 'dispatch'), 'done', runner);
    assert.equal(stepStatus(restart.run, 'monitor'), 'running', runner);
    assert.equal(restart.run.status, 'monitoring', runner);
    assert.equal(restart.run.activeTaskFile, restart.run.taskFile, runner);
    assert.deepEqual(restart.slotWrites, [
      { lifecycle: 'busy', phase: 'working', agent: 'working' },
    ]);
    assert.deepEqual(restart.started, [restart.run.id], 'the engine resumes past DISPATCH');
  }
});

test('restart adopts a post-launch-prompt worker whose delivery was verified', async () => {
  const { restart, deps } = restartAt(dispatchingRun('claude', PROMPT_SENT_AT), {
    slotAgent: 'working',
  });

  await recoverActiveRuns(deps);

  assert.equal(stepStatus(restart.run, 'dispatch'), 'done');
  assert.equal(restart.run.status, 'monitoring');
  assert.deepEqual(restart.started, [restart.run.id]);
});

test('restart holds a worker whose prompt delivery it cannot establish', async () => {
  const cases = [
    { label: 'prompt send interrupted', runner: 'claude', workerAlive: true },
    { label: 'launch blockers unresolved', runner: 'cursor', workerAlive: true },
    { label: 'launch sent, worker not running', runner: 'scripted', workerAlive: false },
  ];
  for (const { label, runner, workerAlive } of cases) {
    const { restart, deps } = restartAt(dispatchingRun(runner, PROMPT_SENT_AT), { workerAlive });

    await recoverActiveRuns(deps);

    const dispatch = restart.run.steps.find((step) => step.name === 'dispatch');
    assert.equal(dispatch?.status, 'failed', label);
    assert.equal(dispatch?.outputs?.promptDeliveryUncertain, true, label);
    assert.equal(stepStatus(restart.run, 'monitor'), 'skipped', label);
    assert.equal(restart.run.status, 'reconciling', label);
    assert.equal(restart.run.metrics.outcome, 'partial', label);
    assert.match(restart.run.error ?? '', /preserved/, label);
    assert.deepEqual(restart.started, [], `${label}: the engine must not re-enter`);
    assert.deepEqual(restart.slotWrites, [], label);
  }
});

test('restart re-runs a dispatch whose attempt never sent a prompt', async () => {
  const cases = [
    { label: 'no worker launched', run: dispatchingRun('scripted'), workerAlive: false },
    { label: 'launched, prompt not sent', run: dispatchingRun('claude'), workerAlive: true },
    {
      label: 'marker from an older attempt',
      run: dispatchingRun('scripted', OLDER_ATTEMPT_AT),
      workerAlive: true,
    },
  ];
  for (const { label, run, workerAlive } of cases) {
    const { restart, deps } = restartAt(run, { workerAlive });

    await recoverActiveRuns(deps);

    assert.equal(stepStatus(run, 'dispatch'), 'running', label);
    assert.equal(run.status, 'dispatching', label);
    assert.deepEqual(restart.started, [run.id], label);
    assert.deepEqual(restart.slotWrites, [], label);
  }
});
