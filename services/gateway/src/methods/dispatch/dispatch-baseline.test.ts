import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';

await import('../../runtime/mock-pty.test-support.js');
const root = await mkdtemp(path.join(os.tmpdir(), 'dispatch-baseline-'));
process.env.FARMSLOT_HOME = root;
process.env.FARMSLOT_RUNS_DIR = path.join(root, 'runs');
process.env.FARMSLOT_POOL_DIR = path.join(root, 'pool');
after(() => rm(root, { recursive: true, force: true }));
const core = await import('../../core/index.js');
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
    },
  },
});
const modulePath: string = './execute.js?dispatch-baseline';
const { dispatchExecute } = (await import(modulePath)) as typeof import('./execute.js');

for (const scenario of [
  { name: 'checkout-preserving replay', skipPrepare: true, prior: baseline, expected: baseline },
  { name: 'first prepared dispatch', skipPrepare: true, prior: null, expected: fixedHead },
  { name: 'new preparation', skipPrepare: false, prior: baseline, expected: fixedHead },
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
      ),
      (error: unknown) => error === stop,
    );
    assert.equal(getRun(run.id)!.worktreeHeadAtDispatch, scenario.expected);
    assert.equal(prepares, scenario.skipPrepare ? 0 : 1);
    // Retaining the evidence base must not hide a changed review checkout.
    assert.deepEqual(captured, [fixedHead]);
  });
}
