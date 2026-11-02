// F328: a monitor a step error parked only observes, so a gateway restart watches again.
import assert from 'node:assert/strict';
import test from 'node:test';

import { FLOW_STEPS, type Run, type RunStep } from '@farmslot/protocol';

import '../runtime/mock-pty.test-support.js';

import { recoverActiveRuns, type RunRecoveryCollaborators } from './recovery.js';
import { makeRun } from './test-fixtures.js';
import {
  REPLAY_STEP_ACTION,
  WORKER_LEFT_RUNNING_DECISION,
  workerLeftRunningDecision,
} from './worker-left-running.js';

const unexpected = (): never => {
  throw new Error('unexpected recovery call');
};

function recoveryDeps(run: Run, started: string[]): RunRecoveryCollaborators {
  return {
    listRuns: () => ({ runs: [run] }),
    loadFleetStatus: async () => ({
      slots: [{ slot: run.slotId!, lifecycle: 'busy', agent: 'working' }],
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
      started.push(runId);
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
    updateSlotStatusIf: unexpected,
    quarantineLeakedRun: async () => {},
    rearmHandoffAutoRecovery: unexpected,
    rearmPublicationReviewRecovery: unexpected,
    recoverInflightPublicationReviews: unexpected,
    replayHumanGate: unexpected,
    resumeHeldPublicationGate: unexpected,
  };
}

function parkedRun(step: 'monitor' | 'review', outputs?: Record<string, unknown>): Run {
  const steps = FLOW_STEPS['fix-bug'];
  const run = makeRun({
    id: 'ce1c5583-dd9f-4664-87f2-b64f02941ee7',
    flowType: 'fix-bug',
    lane: 'production',
    status: 'blocked',
    slotId: 'macpro-mm-5',
    error: 'terminated',
    engineState: { generation: 1 },
    steps: steps.map((name, index) => ({
      name,
      status: index < steps.indexOf(step) ? 'done' : name === step ? 'failed' : 'pending',
      ...(name === step && outputs ? { outputs } : {}),
    })),
  });
  return {
    ...run,
    decisions: [workerLeftRunningDecision(run, step, 'terminated', ['fix-bug'])],
  };
}

test('restart re-enters a monitor that a step error parked', async () => {
  const run = parkedRun('monitor');
  const started: string[] = [];

  await recoverActiveRuns(recoveryDeps(run, started));

  assert.deepEqual(started, [run.id]);
  assert.equal(run.status, 'monitoring');
  assert.equal(run.steps.find((step) => step.name === 'monitor')?.status, 'pending');
  const card = run.decisions.find((decision) => decision.type === WORKER_LEFT_RUNNING_DECISION);
  assert.equal(card?.resolvedAction, REPLAY_STEP_ACTION);
});

test('restart leaves other parked steps, and an uncertain monitor, to the operator', async () => {
  for (const run of [
    parkedRun('review'),
    parkedRun('monitor', { nativeWorkerOperationUncertain: 'delivery' }),
  ]) {
    const started: string[] = [];
    await recoverActiveRuns(recoveryDeps(run, started));
    assert.deepEqual(started, []);
    assert.equal(run.status, 'blocked');
    assert.equal(run.decisions.filter((decision) => !decision.resolvedAt).length, 1);
  }
});
