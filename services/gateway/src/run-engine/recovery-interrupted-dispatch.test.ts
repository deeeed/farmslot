// F331: a restart mid-DISPATCH adopts a worker holding its task instead of relaunching it.
import assert from 'node:assert/strict';
import test from 'node:test';

import { type AgentContext, Events, FLOW_STEPS, type Run, type RunStep } from '@farmslot/protocol';

import '../runtime/mock-pty.test-support.js';

import { retainedMaintenanceStepOutputs } from './branch-maintenance.js';
import { recoverActiveRuns, type RunRecoveryCollaborators } from './recovery.js';
import { makeRun } from './test-fixtures.js';
import { WORKER_LEFT_RUNNING_DECISION } from './worker-left-running.js';

const DISPATCH_STARTED_AT = '2026-11-02T14:03:50.687Z';
const PROMPT_SENT_AT = '2026-11-02T14:03:52.000Z';
const OLDER_ATTEMPT_AT = '2026-11-02T13:00:00.000Z';

type RunEngineFlags = NonNullable<NonNullable<Run['engineState']>['flags']>;

const unexpected = (): never => {
  throw new Error('unexpected recovery call');
};

interface Restart {
  run: Run;
  started: string[];
  slotWrites: Array<Record<string, unknown>>;
  broadcasts: string[];
  nodeWaits: number;
}

interface RestartOptions {
  workerAlive?: boolean;
  /** What the slot row says. A fleet refresh rewrites a dispatching slot's agent to idle. */
  slotAgent?: string;
  slotOwned?: boolean;
  /** Stands in for real reconciliation, which probes the pane. */
  reconcile?: (run: Run) => Promise<void>;
  promptAccepted?: boolean;
}

function restartAt(
  run: Run,
  {
    workerAlive = true,
    slotAgent = 'idle',
    slotOwned = true,
    reconcile,
    promptAccepted = false,
  }: RestartOptions = {},
): { restart: Restart; deps: RunRecoveryCollaborators } {
  const restart: Restart = { run, started: [], slotWrites: [], broadcasts: [], nodeWaits: 0 };
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
    broadcast: (event: string) => restart.broadcasts.push(event),
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
      if (!predicate({ current_run_id: slotOwned ? run.id : 'another-run' })) return false;
      restart.slotWrites.push(fields);
      return true;
    },
    quarantineLeakedRun: async () => {},
    // The real reconciliation probes the pane: live promotes a launching worker, dead blocks it.
    reconcileRunAgentRuntime:
      reconcile ??
      (async (current) => {
        for (const context of current.agentContexts ?? [])
          context.status = workerAlive ? 'working' : 'blocked';
      }),
    dispatchPromptAccepted: async () => promptAccepted,
    withExecutionNodeWait: (_run, operation) => {
      restart.nodeWaits += 1;
      return operation();
    },
    rearmHandoffAutoRecovery: unexpected,
    rearmPublicationReviewRecovery: unexpected,
    recoverInflightPublicationReviews: unexpected,
    replayHumanGate: unexpected,
    resumeHeldPublicationGate: unexpected,
  };
  return { restart, deps };
}

function dispatchingRun(
  runner: string,
  promptDeliveryStartedAt?: string,
  { verified = false, flags }: { verified?: boolean; flags?: RunEngineFlags } = {},
): Run {
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
    ...(flags ? { engineState: { flags } } : {}),
    steps: steps.map((name, index) => {
      if (name === 'dispatch')
        return {
          name,
          status: 'running',
          startedAt: DISPATCH_STARTED_AT,
          ...(verified ? { outputs: { promptDeliveryVerified: true } } : {}),
        };
      return { name, status: index < steps.indexOf('dispatch') ? 'done' : 'pending' };
    }),
  });
  return { ...run, agentContexts: [worker] };
}

const stepStatus = (run: Run, name: string) => run.steps.find((step) => step.name === name)?.status;
const dispatchStep = (run: Run) => run.steps.find((step) => step.name === 'dispatch');
const openCard = (run: Run) =>
  run.decisions.find((decision) => !decision.resolvedAt)?.type === WORKER_LEFT_RUNNING_DECISION
    ? run.decisions.find((decision) => !decision.resolvedAt)
    : undefined;

function assertAdopted(restart: Restart, label?: string) {
  assert.equal(stepStatus(restart.run, 'dispatch'), 'done', label);
  assert.equal(stepStatus(restart.run, 'monitor'), 'running', label);
  assert.equal(restart.run.status, 'monitoring', label);
  assert.equal(restart.run.activeTaskFile, restart.run.taskFile, label);
  assert.deepEqual(restart.started, [restart.run.id], `${label}: the engine resumes past DISPATCH`);
}

function assertHeldOnCard(restart: Restart, label?: string) {
  const dispatch = dispatchStep(restart.run);
  assert.equal(dispatch?.status, 'failed', label);
  assert.equal(restart.run.status, 'blocked', label);
  assert.equal(openCard(restart.run)?.context?.step, 'dispatch', label);
  assert.deepEqual(openCard(restart.run)?.context?.agents, ['fix-bug'], label);
  assert.equal(restart.run.error, dispatch?.detail, label);
  assert.equal(stepStatus(restart.run, 'monitor'), 'pending', label);
  assert.ok(restart.broadcasts.includes(Events.RUN_DECISION_NEW), label);
  assert.deepEqual(restart.started, [], `${label}: the engine must not re-enter`);
  assert.deepEqual(restart.slotWrites, [], label);
}

test('restart adopts a live worker whose launch carried its prompt and resumes at MONITOR', async () => {
  for (const runner of ['scripted', 'pi', 'opencode']) {
    const { restart, deps } = restartAt(dispatchingRun(runner, PROMPT_SENT_AT));

    await recoverActiveRuns(deps);

    assertAdopted(restart, runner);
    assert.deepEqual(restart.slotWrites, [
      { lifecycle: 'busy', phase: 'working', agent: 'working' },
    ]);
  }
});

test('delivery, then a fleet refresh, then a restart: the verified record still adopts', async () => {
  // The refresh rewrote the slot's agent to idle while the run stayed dispatching.
  const run = dispatchingRun('claude', PROMPT_SENT_AT, { verified: true });
  const { restart, deps } = restartAt(run, { slotAgent: 'idle' });

  await recoverActiveRuns(deps);

  assertAdopted(restart);
});

test('a warm claim on the slot proves nothing once its handoff fell back to a cold dispatch', async () => {
  const flags: RunEngineFlags = { warmSessionReuse: true, warmHandoffSucceeded: false };
  const unsent = restartAt(dispatchingRun('claude', undefined, { flags }), {
    slotAgent: 'working',
  });
  await recoverActiveRuns(unsent.deps);
  assert.equal(stepStatus(unsent.restart.run, 'dispatch'), 'running');
  assert.deepEqual(unsent.restart.started, [unsent.restart.run.id]);

  const sent = restartAt(dispatchingRun('claude', PROMPT_SENT_AT, { flags }), {
    slotAgent: 'working',
  });
  await recoverActiveRuns(sent.deps);
  assertHeldOnCard(sent.restart);
});

test('a slot reading working proves nothing for a plain dispatch either', async () => {
  const { restart, deps } = restartAt(dispatchingRun('claude', PROMPT_SENT_AT), {
    slotAgent: 'working',
  });

  await recoverActiveRuns(deps);

  assertHeldOnCard(restart);
});

test('warm handoffs and branch nudges keep the claim as their record', async () => {
  const cases: RunEngineFlags[] = [{ warmSessionReuse: true }, { nudgeReuse: true }];
  for (const flags of cases) {
    const { restart, deps } = restartAt(dispatchingRun('claude', undefined, { flags }), {
      slotAgent: 'working',
    });

    await recoverActiveRuns(deps);

    assertAdopted(restart, JSON.stringify(flags));
  }
});

test('restart blocks on the worker-left-running card a delivery it cannot establish', async () => {
  const cases = [
    { label: 'keys sent, no acknowledgement', runner: 'claude' },
    { label: 'launch blockers unresolved', runner: 'cursor' },
  ];
  for (const { label, runner } of cases) {
    const { restart, deps } = restartAt(dispatchingRun(runner, PROMPT_SENT_AT));

    await recoverActiveRuns(deps);

    assertHeldOnCard(restart, label);
    assert.equal(dispatchStep(restart.run)?.outputs?.promptDeliveryUncertain, true, label);
    assert.equal(restart.run.metrics.outcome, undefined, label);
  }
});

test('the card outlives another restart and is presented again', async () => {
  const { restart, deps } = restartAt(dispatchingRun('claude', PROMPT_SENT_AT));
  await recoverActiveRuns(deps);
  const card = openCard(restart.run);
  restart.broadcasts.length = 0;

  await recoverActiveRuns(deps);

  assert.equal(openCard(restart.run)?.id, card?.id);
  assert.deepEqual(restart.broadcasts, [Events.RUN_DECISION_NEW]);
  assertHeldOnCard(restart);
});

test('a re-entered DISPATCH drops the hold marker, so a restart during it is not skipped', () => {
  assert.equal(
    retainedMaintenanceStepOutputs('dispatch', { promptDeliveryUncertain: true }),
    undefined,
  );
});

test("restart adopts a worker the runner's own evidence shows took the prompt", async () => {
  const cases = [
    { label: 'live, hook digest matched', workerAlive: true },
    { label: 'exited, signal in the task file', workerAlive: false },
  ];
  for (const { label, workerAlive } of cases) {
    const { restart, deps } = restartAt(dispatchingRun('claude', PROMPT_SENT_AT), {
      workerAlive,
      promptAccepted: true,
    });

    await recoverActiveRuns(deps);

    assertAdopted(restart, label);
  }
});

test('a handoff probe that throws reads as uncertain, not as a dead worker', async () => {
  const { restart, deps } = restartAt(dispatchingRun('claude', PROMPT_SENT_AT), {
    workerAlive: false,
  });
  deps.dispatchPromptAccepted = async () => {
    throw new Error('probe failed');
  };

  await recoverActiveRuns(deps);

  assertHeldOnCard(restart);
});

test('a reconciliation error is not an uncertain delivery', async () => {
  const reconcile = async () => {
    throw new Error('No node connected for machine ri-node after 120000ms');
  };

  const held = restartAt(dispatchingRun('scripted', PROMPT_SENT_AT), { reconcile });
  let probes = 0;
  held.deps.dispatchPromptAccepted = async () => {
    probes += 1;
    return false;
  };
  await recoverActiveRuns(held.deps);
  assertHeldOnCard(held.restart);
  assert.equal(probes, 0, 'the node reconciliation could not reach is not probed again');
  assert.equal(dispatchStep(held.restart.run)?.outputs?.promptDeliveryUncertain, undefined);
  assert.match(held.restart.run.error ?? '', /could not be checked: No node connected/);

  const verified = dispatchingRun('claude', PROMPT_SENT_AT, { verified: true });
  const adopted = restartAt(verified, { reconcile });
  await recoverActiveRuns(adopted.deps);
  assertAdopted(adopted.restart);
  assert.equal(adopted.restart.run.agentContexts?.[0]?.status, 'working');

  const unsent = restartAt(dispatchingRun('claude'), { reconcile });
  await recoverActiveRuns(unsent.deps);
  assert.equal(stepStatus(unsent.restart.run, 'dispatch'), 'running');
  assert.deepEqual(unsent.restart.started, [unsent.restart.run.id]);
});

test('only an interrupted delivery waits for its node, and a cancel during the wait stands', async () => {
  const sent = restartAt(dispatchingRun('scripted', PROMPT_SENT_AT));
  await recoverActiveRuns(sent.deps);
  assert.equal(sent.restart.nodeWaits, 1);

  const unsent = restartAt(dispatchingRun('scripted'));
  await recoverActiveRuns(unsent.deps);
  assert.equal(unsent.restart.nodeWaits, 0);

  const cancelled = restartAt(dispatchingRun('claude', PROMPT_SENT_AT), {
    reconcile: async (run) => {
      run.status = 'cancelled';
      throw new Error('Run stopped while awaiting its execution node');
    },
  });
  // A cancelled run's slot goes back through the orphan sweep.
  cancelled.deps.resetSlotIf = async () => false;
  await recoverActiveRuns(cancelled.deps);
  assert.equal(cancelled.restart.run.status, 'cancelled');
  assert.equal(cancelled.restart.run.decisions.length, 0);
  assert.deepEqual(cancelled.restart.started, []);
});

test('adoption restores the session binding a completed DISPATCH would have verified', async () => {
  const run = dispatchingRun('claude', PROMPT_SENT_AT, { verified: true });
  const { restart, deps } = restartAt(run, {
    reconcile: async (current) => {
      Object.assign(current.agentContexts![0]!, {
        status: 'working',
        runnerSessionId: 'session-1',
        runnerSessionPath: '/sessions/session-1.jsonl',
      });
    },
  });

  await recoverActiveRuns(deps);

  assertAdopted(restart);
  const worker = restart.run.agentContexts?.[0];
  assert.equal(worker?.runnerSessionId, 'session-1');
  assert.ok(worker?.runnerSessionCapturedAt, 'REVIEW provenance needs the capture time');
});

test('a slot that no longer records the run is not adopted into', async () => {
  const run = dispatchingRun('claude', PROMPT_SENT_AT, { verified: true });
  const { restart, deps } = restartAt(run, { slotOwned: false });

  await recoverActiveRuns(deps);

  assertHeldOnCard(restart);
  assert.match(restart.run.error ?? '', /no longer records this run/);
});

test('restart re-runs a dispatch whose attempt never sent a prompt or whose runner is gone', async () => {
  const cases = [
    { label: 'no worker launched', run: dispatchingRun('scripted'), workerAlive: false },
    { label: 'in the readiness wait', run: dispatchingRun('claude'), workerAlive: true },
    {
      label: 'marker from an older attempt',
      run: dispatchingRun('scripted', OLDER_ATTEMPT_AT),
      workerAlive: true,
    },
    {
      label: 'launch sent, no runner and no signal',
      run: dispatchingRun('scripted', PROMPT_SENT_AT),
      workerAlive: false,
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
