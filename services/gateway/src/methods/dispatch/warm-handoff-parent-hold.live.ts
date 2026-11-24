import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';

import { primaryRoleForFlow } from '@farmslot/protocol';

// Live proof of c616be16's shape: the parent finishes while its chained warm child is already
// active, the parent's real terminal release holds the slot for the child, and the child's real
// warm handoff claims that hold and sends its prompt. Real: run store, slot status file, the
// parent's terminal release (it stops at the ownership check, before any tmux call) and the
// handoff's claims. Scripted: the runner layer (worker liveness, pane resolution, the prompt
// send), which retained-handoff-smoke proves on its own, fleet status and watchers.
const root = mkdtempSync(path.join(os.tmpdir(), 'warm-handoff-live-'));
for (const name of [
  'pool',
  'home',
  'runs',
  'repo',
  'tmux',
  'projects/proof',
  'tasks/pr-complete/proof',
])
  mkdirSync(path.join(root, name), { recursive: true });
Object.assign(process.env, {
  NODE_TEST_CONTEXT: '1',
  // Any tmux call goes to a private server, never the operator's sessions.
  TMUX_TMPDIR: path.join(root, 'tmux'),
  FARMSLOT_TEST_STATUS_FILE: path.join(root, 'status.json'),
  FARMSLOT_POOL_DIR: path.join(root, 'pool'),
  FARMSLOT_HOME: path.join(root, 'home'),
  FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
  FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
});
// Inside tmux, TMUX names the operator's server and wins over TMUX_TMPDIR.
const operatorTmux = process.env.TMUX;
delete process.env.TMUX;
after(() => {
  if (operatorTmux !== undefined) process.env.TMUX = operatorTmux;
  rmSync(root, { recursive: true, force: true });
});
const repo = path.join(root, 'repo');
const git = (...args: string[]) =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
git('init', '-q', '-b', 'feature');
git(
  '-c',
  'user.name=Proof',
  '-c',
  'user.email=proof@example.invalid',
  'commit',
  '-q',
  '--allow-empty',
  '-m',
  'test: base',
);
const slotId = 'warm-live-proof';
writeFileSync(
  path.join(root, 'pool/fixture.json'),
  JSON.stringify({
    machine: os.hostname(),
    host: 'localhost',
    project: 'proof',
    platform: 'cli',
    slots: [{ id: slotId, repo, session: 'proof' }],
  }),
);
writeFileSync(path.join(root, 'projects/proof/project.json'), JSON.stringify({ name: 'proof' }));
const taskFile = path.join(root, 'tasks/pr-complete/proof/TASK.md');
writeFileSync(taskFile, '# Warm claim proof\n');

const store = await import('../../runs/store.js');
const server = await import('../../server.js');
mock.module('../../server.js', { namedExports: { ...server, broadcastEvent: () => {} } });
const tmux = await import('../../core/tmux.js');
mock.module('../../core/tmux.js', {
  namedExports: {
    ...tmux,
    resolveTmuxSession: async () => 'proof',
    resolveTmuxPaneId: async () => '%7',
  },
});
const fleet = await import('../../fleet/state.js');
mock.module('../../fleet/state.js', {
  namedExports: {
    ...fleet,
    loadFleetStatus: async () => ({ slots: [{ slot: slotId, branch: 'feature' }] }),
  },
});
const preview = await import('./preview.js');
mock.module('./preview.js', {
  namedExports: { ...preview, verifyBranchAffinityNudgeStillEligible: async () => null },
});
const hosted = await import('../../tasks/hosted-task-init.js');
mock.module('../../tasks/hosted-task-init.js', {
  namedExports: { ...hosted, verifyHostedTaskOnSlot: async () => undefined },
});
const lifecycle = await import('../../review/worker-lifecycle.js');
mock.module('../../review/worker-lifecycle.js', {
  namedExports: { ...lifecycle, isWorkerAlive: async () => true },
});
const sessions = await import('../../runners/session-process.js');
mock.module('../../runners/session-process.js', {
  namedExports: {
    ...sessions,
    resolveRetainedRunnerPane: async () => ({ target: 'proof:dev.0', window: 'dev', pane: '0' }),
    resolvePersistedRunnerSessionBinding: () => ({ ok: true, binding: null }),
  },
});
const prompts = await import('../../runners/worker-prompt.js');
mock.module('../../runners/worker-prompt.js', {
  namedExports: { ...prompts, resolveWorkerNudgePrompt: async () => 'fixture task' },
});
const ack = await import('../../runners/prompt-delivery-evidence.js');
mock.module('../../runners/prompt-delivery-evidence.js', {
  namedExports: { ...ack, readLaunchAckSignalSnapshot: async () => null },
});
const checklist = await import('../../tasks/checklist-target.js');
mock.module('../../tasks/checklist-target.js', {
  namedExports: { ...checklist, clearWorkerSignalsForDispatch: async () => undefined },
});
const watcher = await import('../../tasks/watcher.js');
mock.module('../../tasks/watcher.js', {
  namedExports: {
    ...watcher,
    watchContext: async () => undefined,
    watchSlot: async () => undefined,
    unwatchContext: async () => undefined,
    unwatchSlot: async () => undefined,
  },
});
/** Each prompt the retained worker received, with the slot owner at that moment. */
const sends: Array<{ prompt: unknown; owner: unknown }> = [];
const execute = await import('./execute.js');
mock.module('./execute.js', {
  namedExports: {
    ...execute,
    ensureWorkerRoleTarget: async () => 'proof:dev.0',
    isRunnerAliveInAnyPane: async () => true,
    enforceDispatchPressureGate: async () => undefined,
  },
});
// The send itself: the runner adapters it drives are proved by their own live scenarios.
const reactivation = await import('../../runners/session-reactivation.js');
mock.module('../../runners/session-reactivation.js', {
  namedExports: {
    ...reactivation,
    deliverPromptWithRetainedFallback: async (options: { prompt: unknown }) => {
      sends.push({
        prompt: options.prompt,
        owner: (await state.readSlotRow(slotId))?.current_run_id,
      });
      return { delivered: true };
    },
  },
});
const warmModule: string = './warm-session-handoff.js?parent-hold-claim';
const { warmSessionHandoffDispatch } = (await import(
  warmModule
)) as typeof import('./warm-session-handoff.js');
const state = await import('../../core/state.js');
const { releaseCompletedRunSlot } = await import('../run/lifecycle-control.js');

const parent = store.createRun({
  flowType: 'pr-complete',
  project: 'proof',
  ticketOrPr: 'example/repo#1',
  runner: 'claude',
});
await store.persistRunNow(
  store.updateRun(parent.id, {
    slotId,
    status: 'done',
    completedAt: new Date().toISOString(),
    agentContexts: [
      {
        id: 'dev',
        runId: parent.id,
        slotId,
        role: primaryRoleForFlow('pr-complete'),
        label: 'Worker',
        status: 'idle',
        runner: 'claude',
        model: 'opus',
        modelQuestions: 'on',
      },
    ],
  }),
  'warm claim fixture',
);

test('the parent finishes, its teardown holds the slot for its warm child, and the child claims it', async () => {
  await writeFile(
    state.statusFile,
    JSON.stringify({
      slots: [
        {
          slot: slotId,
          lifecycle: 'busy',
          phase: 'ci-watch',
          agent: 'idle',
          slot_epoch: 5,
          current_run_id: parent.id,
          runner: 'claude',
          model: 'opus',
          current_flow_type: 'pr-complete',
        },
      ],
    }),
  );
  // The chain starts the child before the parent publishes done (17:07:13.136 vs .137).
  // update-branch has no find-slot step, so the child counts as active on the slot at once.
  const child = store.createRun({
    flowType: 'update-branch',
    project: 'proof',
    ticketOrPr: 'example/repo#1',
    runner: 'claude',
  });
  store.updateRun(child.id, {
    slotId,
    taskFile,
    parentRunId: parent.id,
    status: 'writing-task',
    engineState: { generation: 0, flags: { skipPrepare: true, warmSessionReuse: true } },
  });
  const started = Date.now();
  const release = await releaseCompletedRunSlot(store.getRun(parent.id)!);
  const held = await state.readSlotRow(slotId);
  console.log(`[proof] parent release: ${JSON.stringify(release)}`);
  console.log(
    `[proof] slot after parent release: lifecycle=${held?.lifecycle} phase=${held?.phase} owner=${held?.current_run_id} cleanup=${held?.cleanup_run_id === parent.id ? 'parent' : held?.cleanup_run_id} reason="${held?.held_reason}"`,
  );
  assert.equal(held?.lifecycle, 'held');
  assert.equal(held?.held_reason, `Another active run ${child.id} uses this slot`);

  store.updateRun(child.id, { status: 'dispatching' });
  const result = await warmSessionHandoffDispatch(
    {
      parentRunId: parent.id,
      slotId,
      taskFile,
      runId: child.id,
      ticketOrPr: 'example/repo#1',
      flowType: 'update-branch',
    },
    () => undefined,
  ).catch((error: Error) => {
    // Main refuses here; record whether the worker had already been given the prompt.
    console.log(`[proof] child handoff refused: ${error.message}; prompts sent: ${sends.length}`);
    throw error;
  });
  const claimed = await state.readSlotRow(slotId);
  console.log(`[proof] child handoff: ${JSON.stringify(result)}`);
  console.log(
    `[proof] slot after child claim: lifecycle=${claimed?.lifecycle} owner=${claimed?.current_run_id === child.id ? 'child' : claimed?.current_run_id} held_reason=${claimed?.held_reason ?? null} cleanup=${claimed?.cleanup_run_id ?? null}`,
  );
  console.log(
    `[proof] prompts sent: ${sends.length}, slot owner at send: ${sends[0]?.owner === child.id ? 'child' : sends[0]?.owner} (${Date.now() - started} ms)`,
  );
  assert.equal(result.handedOff, true);
  assert.equal(sends.length, 1);
  assert.equal(claimed?.current_run_id, child.id);
  assert.equal(claimed?.held_reason ?? null, null);
  store.updateRun(child.id, { status: 'done' });
});
