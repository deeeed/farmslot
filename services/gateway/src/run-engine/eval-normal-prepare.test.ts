import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';

import type { Run } from '@farmslot/protocol';

import type { slotPrepare } from '../methods/slot/prepare.js';
import { makeVars } from '../runners/test-fixtures.js';

import { makeRun } from './test-fixtures.js';

const base = 'a'.repeat(40);
const candidate = 'b'.repeat(40);
const vars = makeVars({ slotId: 'fixture', platform: 'cli', projectName: 'fixture' });
let run: Run;
let branchHead: string | undefined;
let initializationCalls = 0;
const persistedIntents: boolean[] = [];

const store = await import('../runs/store.js');
mock.module('../runs/store.js', {
  namedExports: {
    ...store,
    getRun: () => run,
    updateRun: (_id: string, patch: Partial<Run>) => (run = { ...run, ...patch }),
    updateRunStep: () => run,
    persistRunNow: async () => {
      persistedIntents.push(run.engineState?.prepareBranch?.started ?? false);
    },
  },
});
const config = await import('../core/config.js');
mock.module('../core/config.js', {
  namedExports: {
    ...config,
    loadSlotVars: async () => vars,
    resolveProjectRuntimeDir: async () => '.agent',
  },
});
const exec = await import('../core/exec.js');
mock.module('../core/exec.js', {
  namedExports: { ...exec, execOnSlot: async () => ({ exitCode: 1, stdout: '', stderr: '' }) },
});
const binding = await import('../runs/slot-binding.js');
mock.module('../runs/slot-binding.js', {
  namedExports: { ...binding, ensureRunSlotBinding: () => run },
});
const stack = await import('./stack-base.js');
mock.module('./stack-base.js', { namedExports: { ...stack, ensureRunStack: async () => run } });
const frozen = await import('../qa/frozen-source.js');
mock.module('../qa/frozen-source.js', {
  namedExports: { ...frozen, ensureFrozenQaSource: () => run },
});
mock.module('./remote-probes.js', {
  namedExports: { probeRemotePath: async () => ({ ok: true }) },
});
const sync = await import('./task-sync.js');
mock.module('./task-sync.js', {
  namedExports: {
    ...sync,
    completeRunTaskInitialization: async () => {
      initializationCalls++;
    },
  },
});
const launch = await import('../runners/launch-command.js');
mock.module('../runners/launch-command.js', {
  namedExports: { ...launch, assertRunnerLaunchPrerequisites: () => {} },
});
mock.module('./eval-harness-lifecycle.js', {
  namedExports: { executeEvalHarnessLifecycle: async () => ({ skipped: true }) },
});
const blind = await import('../evals/blind-trial.js');
mock.module('../evals/blind-trial.js', {
  namedExports: { ...blind, prepareBlindTrialGit: async () => {} },
});
const prepare: typeof slotPrepare = async (_params, _emit, _signal, options) => {
  if (!branchHead) {
    // This is slot.prepare's existing refusal for a missing retained branch.
    if (options?.preserveBranch && !options.allowMissingReplayBranch)
      throw new Error('Replay cannot preserve the missing branch');
    assert.deepEqual(persistedIntents, [false], 'intent must be durable before creating a branch');
    assert.equal(options?.startRef?.requestedRef, base);
  }
  await options?.beforeBranchSetup?.();
  branchHead ??= options?.startRef?.requestedRef;
  return {
    prepared: true,
    requestId: 'fixture-prepare',
    startRef: { requestedRef: base, resolvedSha: base, resolvedAt: '2026-11-15T00:00:00.000Z' },
  };
};
const slots = await import('../methods/slot/index.js');
mock.module('../methods/slot.js', { namedExports: { ...slots, slotPrepare: prepare } });
// Prior fixture imports can load the owner before its boundary mocks are installed.
const prepareOwner: string = './dispatch-lifecycle-steps.js?normal-slot-retry-test';
const { executePrepareStep }: typeof import('./dispatch-lifecycle-steps.js') = await import(
  prepareOwner
);

beforeEach(() => {
  persistedIntents.length = 0;
  branchHead = undefined;
  initializationCalls = 0;
  run = makeRun({
    id: 'normal-prepare',
    status: 'preparing',
    mode: 'autonomous',
    completionPolicy: 'artifact-only',
    ticketOrPr: 'EVAL-fixture',
    prNumber: undefined,
    project: 'fixture',
    slotId: vars.slotId,
    branch: 'eval/fixture',
    startRef: { requestedRef: base, source: { kind: 'manual' } },
    engineState: {
      evalExperiment: {
        experimentId: 'fixture',
        experimentKey: 'fixture',
        experimentManifestPath: '/fixture/experiment.json',
        packagePath: '/fixture/package.json',
        candidateStrategyFingerprint: 'fixture',
        trialId: 'fixture',
        blind: {
          version: 1,
          executionPolicy: 'normal-slot',
          baseSha: base,
          problemDigest: 'problem',
          referenceCommits: [candidate],
          referencePatchId: 'reference',
          forbiddenInputs: [],
        },
      },
    },
  });
});

async function prepareRun() {
  return executePrepareStep(run.id, {
    activeMonitors: new Map(),
    broadcastFn: () => {},
    getRunFlags: () => undefined,
    normalizeEvalReplayForTaskWrite: async (_id, current) => current,
    stepPartialIO: new Map(),
  });
}

for (const stepName of ['find-slot', 'prepare'] as const) {
  test(`normal-slot ${stepName} replay before first branch setup creates at the frozen base`, async () => {
    run.recoveryAttempts = [
      {
        id: 'retry',
        attempt: 1,
        stepName,
        startedAt: run.updatedAt,
        status: 'started',
        triggeredBy: 'operator',
      },
    ];
    assert.equal((await prepareRun()).outputs?.success, true);
    assert.equal(branchHead, base);
    assert.equal(initializationCalls, 1);
    assert.deepEqual(persistedIntents, [false, true]);
  });
}

test('normal-slot prepare preserves candidate progress and refuses a lost established branch', async () => {
  run.engineState!.prepareBranch = { slotId: vars.slotId, branch: run.branch!, started: true };
  run.engineState!.evalExperiment!.blind!.workspace = {
    slotId: vars.slotId,
    slotEpoch: 1,
    preparedAt: '2026-11-15T00:00:00.000Z',
    baseVerifiedAt: '2026-11-15T00:00:00.000Z',
  };
  run.recoveryAttempts = [
    {
      id: 'retry',
      attempt: 1,
      stepName: 'find-slot',
      startedAt: run.updatedAt,
      status: 'started',
      triggeredBy: 'operator',
    },
  ];
  branchHead = candidate;
  assert.equal((await prepareRun()).outputs?.success, true);
  assert.equal(branchHead, candidate);
  branchHead = undefined;
  await assert.rejects(prepareRun(), /Replay cannot preserve/);
});
