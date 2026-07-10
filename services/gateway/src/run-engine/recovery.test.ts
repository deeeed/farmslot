import assert from 'node:assert/strict';
import test from 'node:test';

import type { Run, RunStep, SubStepRecord } from '@farmslot/protocol';

import {
  prepareSubstepsShowCompletion,
  recoverActiveRuns,
  recoveryHealthIsReady,
  type RunRecoveryCollaborators,
} from './recovery.js';

test('recoveryHealthIsReady requires configured ready indicator to match', () => {
  assert.equal(recoveryHealthIsReady({ exitCode: 0, stdout: 'OK\n' }, 'OK'), true);
  assert.equal(recoveryHealthIsReady({ exitCode: 0, stdout: 'MANIFEST_ONLY\n' }, 'OK'), false);
  assert.equal(recoveryHealthIsReady({ exitCode: 0, stdout: '' }, 'OK'), false);
  assert.equal(recoveryHealthIsReady({ exitCode: 1, stdout: 'OK\n' }, 'OK'), false);
});

function minimalActiveRun(overrides: Partial<Run> = {}): Run {
  return {
    id: '5dd53883-bb8f-4f24-a20e-a20ab2856974',
    familyId: '5dd53883-bb8f-4f24-a20e-a20ab2856974',
    parentRunId: null,
    familyRootTicketOrPr: 'PUBLISH-DRIFT-19F18DBCB68',
    lane: 'production',
    variant: null,
    flowType: 'fix-bug',
    mode: 'autonomous',
    status: 'writing-task',
    project: 'farmslot-farm',
    ticketOrPr: 'PUBLISH-DRIFT-19F18DBCB68',
    slotId: 'macwork-ff-2',
    branch: null,
    taskFile: '/var/folders/xx/farmslot-package-drift-AbCdEf/task.md',
    steps: [{ name: 'write-task', status: 'running' }],
    decisions: [],
    metrics: {
      nudgeCount: 0,
      model: null,
      runner: null,
      runnerSessionId: null,
      runnerSessionPath: null,
    },
    createdAt: '2026-06-30T14:08:05.000Z',
    updatedAt: '2026-06-30T14:25:00.000Z',
    ...overrides,
  };
}

test('recoverActiveRuns quarantines leaked gateway test runs before orchestration', async () => {
  let quarantined = false;
  const deps = {
    listRuns: () => ({ runs: [minimalActiveRun()] }),
    loadFleetStatus: async () => ({ slots: [] }),
    quarantineLeakedRun: async () => {
      quarantined = true;
    },
  } as unknown as RunRecoveryCollaborators;

  await recoverActiveRuns(deps);
  assert.equal(quarantined, true);
});

test('recoverActiveRuns isolates tmux runtime reconciliation failures', async () => {
  const run = minimalActiveRun({
    ticketOrPr: 'RECOVERY-1',
    familyRootTicketOrPr: 'RECOVERY-1',
    taskFile: '/tmp/farmslot-recovery-1/TASK.md',
    status: 'blocked',
    steps: [{ name: 'human-gate', status: 'running' }],
    decisions: [
      {
        id: 'decision-1',
        type: 'engine_human_gate',
        title: 'Review publish package',
        description: 'Review publish package',
        actions: [{ id: 'hold', label: 'Hold', style: 'secondary' }],
        createdAt: '2026-06-30T14:20:00.000Z',
      },
    ],
  });
  let reconciled = false;
  let broadcasted = false;
  const deps = {
    listRuns: () => ({ runs: [run] }),
    loadFleetStatus: async () => ({
      slots: [{ slot: run.slotId!, lifecycle: 'busy', agent: 'working' }],
    }),
    reconcileRunAgentRuntime: async () => {
      reconciled = true;
      throw new Error('tmux probe failed');
    },
    updateRun: () => {},
    broadcast: () => {
      broadcasted = true;
    },
    updateRunStep: () => {},
    setPrHealthOverlay: () => {},
    quarantineLeakedRun: async () => {},
  } as unknown as RunRecoveryCollaborators;

  await recoverActiveRuns(deps);

  assert.equal(reconciled, true);
  assert.equal(broadcasted, true, 'pending decision should still be re-presented');
});

test('recoverActiveRuns clears stale human-gate running detail while re-presenting decision', async () => {
  const run = minimalActiveRun({
    ticketOrPr: 'RECOVERY-2',
    familyRootTicketOrPr: 'RECOVERY-2',
    taskFile: '/tmp/farmslot-recovery-2/TASK.md',
    status: 'blocked',
    steps: [{ name: 'human-gate', status: 'running', detail: 'Running dispatch cursor review' }],
    decisions: [
      {
        id: 'decision-1',
        type: 'engine_human_gate',
        title: 'Review publish package',
        description: 'Review publish package',
        actions: [{ id: 'hold', label: 'Hold', style: 'secondary' }],
        createdAt: '2026-06-30T14:20:00.000Z',
      },
    ],
  });
  const stepUpdates: Array<Partial<RunStep>> = [];
  const deps = {
    listRuns: () => ({ runs: [run] }),
    loadFleetStatus: async () => ({
      slots: [{ slot: run.slotId!, lifecycle: 'busy', agent: 'working' }],
    }),
    updateRun: () => {},
    updateRunStep: (_id: string, stepName: string, fields: Partial<RunStep>) => {
      if (stepName === 'human-gate') stepUpdates.push(fields);
    },
    broadcast: () => {},
    setPrHealthOverlay: () => {},
    quarantineLeakedRun: async () => {},
  } as unknown as RunRecoveryCollaborators;

  await recoverActiveRuns(deps);

  assert.deepEqual(stepUpdates, [{ detail: 'Waiting for operator decision' }]);
});

test('prepareSubstepsShowCompletion recognises a terminal health sub-step', () => {
  const complete = (detail: string): RunStep => ({
    name: 'prepare',
    status: 'running',
    outputs: { subSteps: [{ name: 'health', outcome: 'ok', durationMs: 1, detail }] },
  });
  assert.equal(prepareSubstepsShowCompletion(complete('Health check — OK')), true);
  assert.equal(
    prepareSubstepsShowCompletion(complete('Health check skipped (profile attach)')),
    true,
  );
  // Interrupted mid-flight: last sub-step is preflight, health never ran.
  assert.equal(
    prepareSubstepsShowCompletion({
      name: 'prepare',
      status: 'running',
      outputs: {
        subSteps: [
          { name: 'deps', outcome: 'ok', durationMs: 1 },
          {
            name: 'preflight',
            outcome: 'ok',
            durationMs: 1,
            detail: 'Running preflight (Webpack)...',
          },
        ],
      },
    }),
    false,
  );
  // Health phase started but not resolved.
  assert.equal(prepareSubstepsShowCompletion(complete('Verifying health...')), false);
  assert.equal(prepareSubstepsShowCompletion(undefined), false);
  assert.equal(
    prepareSubstepsShowCompletion({
      name: 'prepare',
      status: 'running',
      outputs: { subSteps: [] },
    }),
    false,
  );
});

// ─── prepare recovery false-positive guard ───

function preparingRun(subSteps: SubStepRecord[]): Run {
  return minimalActiveRun({
    status: 'preparing',
    flowType: 'fix-bug',
    project: 'metamask-extension-farm',
    ticketOrPr: 'PERPS-1234',
    familyRootTicketOrPr: 'PERPS-1234',
    taskFile: '/tmp/farmslot-run/PERPS-1234/task.md',
    slotId: 'macwork-mmedev-2',
    steps: [
      { name: 'find-slot', status: 'done' },
      { name: 'write-task', status: 'done' },
      { name: 'prepare', status: 'running', outputs: { subSteps } },
    ],
  });
}

interface PrepareRecoveryCalls {
  healthChecked: boolean;
  prepareStepUpdates: Array<Partial<RunStep>>;
  runUpdates: Array<Partial<Run>>;
  warmRecovery: boolean;
}

function buildPrepareRecoveryDeps(
  run: Run,
  opts: { killed: boolean; healthExit?: number; healthStdout?: string },
): { deps: RunRecoveryCollaborators; calls: PrepareRecoveryCalls } {
  const calls: PrepareRecoveryCalls = {
    healthChecked: false,
    prepareStepUpdates: [],
    runUpdates: [],
    warmRecovery: false,
  };
  const deps = {
    listRuns: () => ({ runs: [run] }),
    loadFleetStatus: async () => ({
      slots: [{ slot: run.slotId!, lifecycle: 'busy', agent: 'idle' }],
    }),
    getRun: () => run,
    updateRun: (_id: string, fields: Partial<Run>) => {
      calls.runUpdates.push(fields);
      if (fields.status) run.status = fields.status;
    },
    updateRunStep: (_id: string, stepName: string, fields: Partial<RunStep>) => {
      if (stepName === 'prepare') calls.prepareStepUpdates.push(fields);
    },
    loadSlotVars: async () => ({ remoteRepo: '/repo', slotId: run.slotId }),
    loadProjectVarsOrNull: async () => ({
      runtimeDir: 'temp/recipe/runtime',
      projectJson: {},
    }),
    getProjectFieldRaw: () => [],
    expandTemplate: (t: string) => t,
    clearStalePrepareProcess: async () => opts.killed,
    expandHook: () => 'test -f {{runtime_dir}}/extension.id && echo OK',
    execOnSlot: async () => {
      calls.healthChecked = true;
      return { exitCode: opts.healthExit ?? 0, stdout: opts.healthStdout ?? 'OK' };
    },
    getProjectField: () => 'OK',
    setRunFlags: (_id: string, flags: { warmRecovery?: true }) => {
      if (flags.warmRecovery) calls.warmRecovery = true;
    },
    startRun: async () => {},
    resetSlot: async () => {},
    quarantineLeakedRun: async () => {},
  } as unknown as RunRecoveryCollaborators;
  return { deps, calls };
}

test('prepare recovery re-runs prepare when it killed an in-flight preflight even if health would pass', async () => {
  // Preflight running, then killed by recovery; a stale extension.id would pass
  // the weak health_check. Recovery must NOT trust that health signal.
  const run = preparingRun([
    { name: 'deps', outcome: 'ok', durationMs: 1 },
    { name: 'preflight', outcome: 'ok', durationMs: 1, detail: 'Running preflight (Webpack)...' },
  ]);
  const { deps, calls } = buildPrepareRecoveryDeps(run, {
    killed: true,
    healthExit: 0,
    healthStdout: 'OK',
  });

  await recoverActiveRuns(deps);

  assert.equal(calls.healthChecked, false, 'health must not be consulted after a kill');
  assert.equal(calls.warmRecovery, true, 'prepare must be re-run via warm recovery');
  assert.ok(
    calls.prepareStepUpdates.some((f) => f.status === 'pending'),
    'prepare step must be reset to pending',
  );
  assert.ok(
    !calls.prepareStepUpdates.some((f) => f.detail === 'Recovered (slot healthy)'),
    'prepare must never be marked recovered after a kill',
  );
});

test('prepare recovery skips prepare only when nothing killed and sub-steps complete', async () => {
  const run = preparingRun([
    { name: 'preflight', outcome: 'ok', durationMs: 1, detail: 'Preflight completed (log: x)' },
    { name: 'health', outcome: 'ok', durationMs: 1, detail: 'Health check — OK' },
  ]);
  const { deps, calls } = buildPrepareRecoveryDeps(run, {
    killed: false,
    healthExit: 0,
    healthStdout: 'OK',
  });

  await recoverActiveRuns(deps);

  assert.equal(calls.healthChecked, true, 'health check runs for the legitimate skip path');
  assert.ok(
    calls.prepareStepUpdates.some(
      (f) => f.status === 'done' && f.detail === 'Recovered (slot healthy)',
    ),
    'prepare marked recovered/done',
  );
  assert.ok(
    calls.runUpdates.some((f) => f.status === 'dispatching'),
    'run advances to dispatching',
  );
  assert.equal(calls.warmRecovery, false, 'no warm re-run when the skip is legitimate');
});

test('prepare recovery re-runs prepare when sub-steps show incomplete phases', async () => {
  // Nothing was killed, but preflight never completed and health never ran, so a
  // passing health probe cannot be trusted.
  const run = preparingRun([
    { name: 'preflight', outcome: 'ok', durationMs: 1, detail: 'Running preflight (Webpack)...' },
  ]);
  const { deps, calls } = buildPrepareRecoveryDeps(run, {
    killed: false,
    healthExit: 0,
    healthStdout: 'OK',
  });

  await recoverActiveRuns(deps);

  assert.equal(calls.healthChecked, false, 'health skipped when sub-steps are incomplete');
  assert.equal(calls.warmRecovery, true, 'prepare must be re-run via warm recovery');
  assert.ok(
    !calls.prepareStepUpdates.some((f) => f.detail === 'Recovered (slot healthy)'),
    'prepare must never be marked recovered with incomplete sub-steps',
  );
});
