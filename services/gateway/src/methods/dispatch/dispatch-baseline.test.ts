import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';

import type { SlotPrepareResult } from '../slot/shared.js';

await import('../../runtime/mock-pty.test-support.js');
const root = await mkdtemp(path.join(os.tmpdir(), 'dispatch-baseline-'));
process.env.FARMSLOT_HOME = root;
process.env.FARMSLOT_RUNS_DIR = path.join(root, 'runs');
process.env.FARMSLOT_POOL_DIR = path.join(root, 'pool');
after(() => rm(root, { recursive: true, force: true }));
const core = await import('../../core/index.js');
const config = await import('../../core/config.js');
const execution = await import('../../core/exec.js');
const remote = await import('../../run-engine/remote-probes.js');
const providers = await import('../../runners/status-provider.js');
const dispatch = await import('../dispatch.js');
const capabilities = await import('../../run-engine/declared-capabilities.js');
const snapshots = await import('../../run-engine/diff-artifacts.js');
const admission = await import('../../backlog/pr-admission.js');
const slots = await import('../slot.js');
const { makeVars } = await import('../../runners/test-fixtures.js');
const { createRun, deleteRun, getRun, updateRun } = await import('../../runs/store.js');
const vars = makeVars({ projectName: 'dispatch-baseline', platform: 'cli' });
const baseline = 'a058550f8d0ad59470460ca37afb252d17380b48';
const fixedHead = 'f3f36fc1' + '1'.repeat(32);
const captured: string[] = [];
let prepares = 0;
const stop = new Error('Fixture stops before worker task copy or launch');

mock.module('../../core/config.js', {
  namedExports: {
    ...config,
    loadSlotVars: async () => vars,
    resolveProjectRuntimeDir: async () => 'temp/farmslot',
  },
});
mock.module('../../core/exec.js', {
  namedExports: {
    ...execution,
    execOnSlot: async () => ({ stdout: '', stderr: '', exitCode: 1 }),
  },
});
mock.module('../../run-engine/remote-probes.js', {
  namedExports: { ...remote, probeRemotePath: async () => ({ ok: true }) },
});
mock.module('../../runners/status-provider.js', {
  namedExports: { ...providers, getRunnerStatusProvider: () => undefined },
});
mock.module('../../core/index.js', {
  namedExports: {
    ...core,
    loadSlotVars: async () => vars,
    loadProjectVars: async () => ({ projectJson: {}, projectConfig: 'project.json' }),
  },
});
mock.module('../../run-engine/declared-capabilities.js', {
  namedExports: {
    ...capabilities,
    prepareDispatchRunCapabilities: async () => {
      throw stop;
    },
  },
});
mock.module('../../run-engine/diff-artifacts.js', {
  namedExports: { ...snapshots, captureWorktreeHeadSha: async () => fixedHead },
});
mock.module('../../backlog/pr-admission.js', {
  namedExports: {
    ...admission,
    assertPRReviewWorktreeHead: (
      ...args: Parameters<typeof admission.assertPRReviewWorktreeHead>
    ) => {
      captured.push(args[1]!);
      return admission.assertPRReviewWorktreeHead(...args);
    },
  },
});
mock.module('../slot.js', {
  namedExports: {
    ...slots,
    slotPrepare: async () => {
      prepares++;
      return { prepared: true, requestId: 'fixture-prepare' } satisfies SlotPrepareResult;
    },
  },
});
const signatureChecks = await import('../../run-completion/commit-signatures.js');
let refuseInheritedUnsigned = false;
const unsignedRefusal = new Error('Unsigned outgoing commit(s): fixture-before-dispatch');
mock.module('../../run-completion/commit-signatures.js', {
  namedExports: {
    ...signatureChecks,
    assertInheritedPrCommitsSigned: async (
      ...args: Parameters<typeof signatureChecks.assertInheritedPrCommitsSigned>
    ) => {
      if (refuseInheritedUnsigned) throw unsignedRefusal;
      return signatureChecks.assertInheritedPrCommitsSigned(...args);
    },
  },
});
const modulePath: string = './execute.js?dispatch-baseline';
const { dispatchExecute } = (await import(modulePath)) as typeof import('./execute.js');
let engineSkipPrepare: boolean | undefined;
mock.module('../dispatch.js', {
  namedExports: {
    ...dispatch,
    dispatchExecute: (...args: Parameters<typeof dispatchExecute>) => {
      engineSkipPrepare = args[0].skipPrepare;
      return dispatchExecute(...args);
    },
  },
});
const engineModule: string = '../../run-engine/dispatch-lifecycle-steps.js?dispatch-baseline';
const {
  executePrepareStep,
  executeDispatchStep,
}: typeof import('../../run-engine/dispatch-lifecycle-steps.js') = await import(engineModule);

for (const scenario of [
  {
    name: 'checkout-preserving replay',
    skipPrepare: true,
    prior: baseline,
    expected: baseline,
    activation: false,
  },
  {
    name: 'first prepared dispatch',
    skipPrepare: true,
    prior: null,
    expected: fixedHead,
    activation: false,
  },
  {
    name: 'new preparation',
    skipPrepare: false,
    prior: baseline,
    expected: fixedHead,
    activation: false,
  },
  {
    name: 'slot activation preparation',
    skipPrepare: false,
    prior: baseline,
    expected: baseline,
    activation: true,
  },
  {
    name: 'first slot activation',
    skipPrepare: false,
    prior: null,
    expected: fixedHead,
    activation: true,
  },
]) {
  test(`${scenario.name} keeps the correct before-evidence baseline`, async (t) => {
    const task = path.join(root, 'TASK.md');
    await writeFile(task, '# Worker: dev\n\n**Branch:** feat/dispatch-baseline\n');
    const run = createRun({
      flowType: 'dev',
      project: vars.projectName,
      ticketOrPr: 'TAT-4153',
      slotId: vars.slotId,
      transport: 'tmux',
      mode: 'autonomous',
    });
    updateRun(run.id, { worktreeHeadAtDispatch: scenario.prior });
    await core.rewriteStatusFile(() => ({
      slots: [
        {
          slot: vars.slotId,
          current_run_id: run.id,
          slot_epoch: 1,
          lifecycle: 'ready',
          phase: null,
          agent: 'idle',
        },
      ],
    }));
    t.after(async () => {
      updateRun(run.id, { status: 'done' });
      await deleteRun(run.id);
    });
    prepares = 0;
    captured.length = 0;
    await assert.rejects(
      dispatchExecute(
        {
          slotId: vars.slotId,
          runId: run.id,
          taskFile: task,
          runner: 'claude',
          model: 'opus',
          mode: 'autonomous',
          skipPrepare: scenario.skipPrepare,
        },
        () => {},
        { preserveDispatchBaseline: scenario.activation },
      ),
      (error: unknown) => error === stop,
    );
    assert.equal(getRun(run.id)!.worktreeHeadAtDispatch, scenario.expected);
    assert.equal(prepares, scenario.skipPrepare ? 0 : 1);
    // Retaining the evidence base must not hide a changed review checkout.
    assert.deepEqual(captured, [fixedHead]);
  });
}

for (const scenario of [
  {
    name: 'ordinary preparation',
    skipPrepare: false,
    activation: false,
    prior: baseline,
    expected: fixedHead,
  },
  {
    name: 'retained checkout',
    skipPrepare: true,
    activation: false,
    prior: baseline,
    expected: baseline,
  },
  {
    name: 'slot activation',
    skipPrepare: false,
    activation: true,
    prior: baseline,
    expected: baseline,
  },
  {
    name: 'first slot activation',
    skipPrepare: false,
    activation: true,
    prior: null,
    expected: fixedHead,
  },
]) {
  const { skipPrepare } = scenario;
  test(`engine prepare then dispatch preserves the correct baseline for ${scenario.name}`, async (t) => {
    const taskFile = path.join(root, 'ENGINE-TASK.md');
    await writeFile(taskFile, '# Worker: dev\n\n**Branch:** feat/dispatch-baseline\n');
    const run = createRun({
      flowType: 'dev',
      project: vars.projectName,
      ticketOrPr: 'TAT-4153',
      slotId: vars.slotId,
      transport: 'tmux',
      mode: 'autonomous',
    });
    updateRun(run.id, {
      taskFile,
      worktreeHeadAtDispatch: scenario.prior,
      steps: run.steps.map((step) =>
        step.name === 'dispatch' && scenario.activation && scenario.prior
          ? { ...step, inputs: { activationDispatchBaseline: scenario.prior } }
          : step,
      ),
      engineState: { flags: skipPrepare ? { skipPrepare: true } : {} },
      metrics: { ...run.metrics, runner: 'claude', model: 'opus' },
    });
    t.after(async () => {
      updateRun(run.id, { status: 'done' });
      await deleteRun(run.id);
    });
    await core.rewriteStatusFile(() => ({
      slots: [
        {
          slot: vars.slotId,
          current_run_id: run.id,
          slot_epoch: 1,
          lifecycle: 'ready',
          agent: 'idle',
          phase: null,
        },
      ],
    }));
    prepares = 0;
    captured.length = 0;
    engineSkipPrepare = undefined;
    const preparation = await executePrepareStep(run.id, {
      activeMonitors: new Map(),
      broadcastFn: () => {},
      getRunFlags: (id) =>
        getRun(id)?.engineState?.flags?.skipPrepare ? { skipPrepare: true } : {},
      normalizeEvalReplayForTaskWrite: async (_id, current) => current,
      stepPartialIO: new Map(),
    });
    assert.equal(prepares, skipPrepare ? 0 : 1);
    assert.equal(preparation.outputs?.skipped === true, skipPrepare);
    await assert.rejects(
      executeDispatchStep(run.id, {
        stepPartialIO: new Map(),
        blockedRunError: (message) => new Error(message),
      }),
      (error: unknown) => error === stop,
    );
    assert.equal(engineSkipPrepare, true, 'engine prevents duplicate preparation inside dispatch');
    assert.equal(getRun(run.id)!.worktreeHeadAtDispatch, scenario.expected);
    assert.deepEqual(captured, [fixedHead]);
  });
}

test('fresh dispatch validates inherited local commits before trusting its baseline', async (t) => {
  const task = path.join(root, 'SIGNED-TASK.md');
  await writeFile(task, '# Worker: dev\n\n**Branch:** feat/dispatch-baseline\n');
  const run = createRun({
    flowType: 'dev',
    project: vars.projectName,
    ticketOrPr: 'TAT-4153',
    slotId: vars.slotId,
    transport: 'tmux',
    mode: 'autonomous',
  });
  updateRun(run.id, { prNumber: 1, branch: 'feat/dispatch-baseline' });
  await core.rewriteStatusFile(() => ({
    slots: [
      {
        slot: vars.slotId,
        current_run_id: run.id,
        slot_epoch: 1,
        lifecycle: 'ready',
        phase: null,
        agent: 'idle',
      },
    ],
  }));
  t.after(async () => {
    refuseInheritedUnsigned = false;
    updateRun(run.id, { status: 'done' });
    await deleteRun(run.id);
  });
  refuseInheritedUnsigned = true;
  await assert.rejects(
    dispatchExecute(
      {
        slotId: vars.slotId,
        runId: run.id,
        taskFile: task,
        runner: 'claude',
        model: 'opus',
        mode: 'autonomous',
        skipPrepare: true,
      },
      () => undefined,
    ),
    (error) => error === unsignedRefusal,
  );
  assert.equal(getRun(run.id)?.worktreeHeadAtDispatch, undefined);
});
