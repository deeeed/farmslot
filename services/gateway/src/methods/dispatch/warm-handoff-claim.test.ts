import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';

import '../../runtime/mock-pty.test-support.js';

// c616be16: pr-complete 12afdc85 chained update-branch c616be16, whose warm handoff delivered
// its prompt and then failed to claim the hold the parent's teardown had left for it.
const root = mkdtempSync(path.join(os.tmpdir(), 'warm-handoff-claim-'));
for (const name of ['pool', 'home', 'runs', 'repo', 'projects/proof', 'tasks/pr-complete/proof'])
  mkdirSync(path.join(root, name), { recursive: true });
Object.assign(process.env, {
  FARMSLOT_POOL_DIR: path.join(root, 'pool'),
  FARMSLOT_HOME: path.join(root, 'home'),
  FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
  FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
});
after(() => rmSync(root, { recursive: true, force: true }));
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
const slotId = 'warm-claim-proof';
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

/** The slot row, as the status file would hold it. */
let row: Record<string, unknown> = {};
const store = await import('../../runs/store.js');
const core = await import('../../core/index.js');
mock.module('../../core/index.js', {
  namedExports: {
    ...core,
    readSlotRow: async () => ({ ...row }),
    readSlotField: async (_slot: string, field: string) =>
      field === 'current_run_id'
        ? (row.current_run_id ?? null)
        : ((
            { runner: 'claude', model: 'opus', current_flow_type: 'dev' } as Record<string, string>
          )[field] ?? null),
    claimSlotStatusIf: async (
      _slot: string,
      predicate: (slot: Readonly<Record<string, unknown>>) => boolean,
      fields: Record<string, unknown>,
    ) => {
      if (!predicate({ ...row })) return { claimed: false, epoch: null };
      const epoch = (Number(row.slot_epoch) || 0) + 1;
      row = { ...row, ...fields, slot_epoch: epoch };
      return { claimed: true, epoch };
    },
    updateSlotStatusIf: async (
      _slot: string,
      predicate: (slot: Readonly<Record<string, unknown>>) => boolean,
      fields: Record<string, unknown>,
    ) => {
      if (!predicate({ ...row })) return false;
      row = { ...row, ...fields };
      return true;
    },
  },
});
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
/** What the send sees and does: the row at the moment of delivery, and its outcome. */
const sends: Array<Record<string, unknown>> = [];
let onSend: () => { delivered: boolean } = () => ({ delivered: true });
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
    deliverPromptWithRetainedFallback: async () => {
      const worker = store
        .getRun(activeChild)
        ?.agentContexts?.find((context) => context.role === 'dev');
      sends.push({ ...row, worker_status: worker?.status, worker_pane: worker?.target?.pane });
      const outcome = onSend();
      return outcome.delivered
        ? outcome
        : { delivered: false, disposition: 'hold', reason: 'fixture send refused' };
    },
  },
});
const warmModule: string = './warm-session-handoff.js?parent-hold-claim';
const { warmSessionHandoffDispatch } = (await import(
  warmModule
)) as typeof import('./warm-session-handoff.js');
const { activeRunOnSlotReason } = await import('./slot-scoring.js');

const parent = store.createRun({
  flowType: 'dev',
  project: 'proof',
  ticketOrPr: 'example/repo#1',
  runner: 'claude',
});
await store.persistRunNow(
  store.updateRun(parent.id, {
    slotId,
    status: 'done',
    agentContexts: [
      {
        id: 'dev',
        runId: parent.id,
        slotId,
        role: 'dev',
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

/** The child under test, whose worker record the send stub reads. */
let activeChild = '';
async function chainedChild(t: { after: (fn: () => Promise<void>) => void }) {
  const child = store.createRun({
    flowType: 'pr-complete',
    project: 'proof',
    ticketOrPr: 'example/repo#1',
    runner: 'claude',
  });
  store.updateRun(child.id, {
    slotId,
    taskFile,
    parentRunId: parent.id,
    status: 'dispatching',
    engineState: { generation: 0, flags: { skipPrepare: true, warmSessionReuse: true } },
  });
  t.after(async () => {
    store.updateRun(child.id, { status: 'done' });
    await store.deleteRun(child.id);
  });
  activeChild = child.id;
  return child;
}
const handoff = (runId: string) =>
  warmSessionHandoffDispatch(
    {
      parentRunId: parent.id,
      slotId,
      taskFile,
      runId,
      ticketOrPr: 'example/repo#1',
      flowType: 'pr-complete',
    },
    () => undefined,
  );
/** The hold P's teardown writes when its warm child is already active. */
const parentHold = (childId: string) => ({
  slot: slotId,
  slot_epoch: 9,
  lifecycle: 'held',
  phase: 'occupied',
  agent: 'idle',
  current_run_id: null,
  cleanup_run_id: parent.id,
  handoff_run_id: null,
  held_reason: activeRunOnSlotReason(childId),
  // P's idle cap stopped its dev server; the send restores it only for the slot's owner.
  idle_devserver_epoch: 9,
  idle_devservers: ['web'],
});

test("the warm child claims its parent's hold before the send and owns the slot after", async (t) => {
  const child = await chainedChild(t);
  row = parentHold(child.id);
  sends.length = 0;
  onSend = () => ({ delivered: true });
  const result = await handoff(child.id);
  assert.equal(result.handedOff, true);
  assert.equal(sends.length, 1);
  const atSend = sends[0]!;
  assert.equal(atSend.current_run_id, child.id, 'the dev-server restore finds an owner');
  assert.equal(atSend.idle_devserver_epoch, atSend.slot_epoch, 'the idle marker stays current');
  assert.notEqual(atSend.agent, 'working', 'the worker is not marked working before the send');
  assert.equal(row.current_run_id, child.id);
  assert.equal(row.lifecycle, 'busy');
  assert.equal(row.agent, 'working');
  assert.equal(row.held_reason, null);
  assert.equal(row.cleanup_run_id, null);
});

test("a parent's hold that lands during the send is claimed after it", async (t) => {
  const child = await chainedChild(t);
  // P still owns the row when the handoff starts; its teardown holds the slot mid-send.
  row = {
    slot: slotId,
    slot_epoch: 3,
    lifecycle: 'busy',
    phase: 'working',
    current_run_id: parent.id,
  };
  sends.length = 0;
  onSend = () => {
    row = { ...parentHold(child.id), slot_epoch: 4 };
    return { delivered: true };
  };
  const result = await handoff(child.id);
  assert.equal(result.handedOff, true);
  assert.equal(row.current_run_id, child.id);
  assert.equal(row.held_reason, null);
  assert.equal(row.cleanup_run_id, null);
});

test("a send that does not land gives the parent's hold back", async (t) => {
  const child = await chainedChild(t);
  row = parentHold(child.id);
  onSend = () => ({ delivered: false });
  const result = await handoff(child.id);
  assert.equal(result.handedOff, false);
  assert.equal(row.current_run_id, null);
  assert.equal(row.lifecycle, 'held');
  assert.equal(row.cleanup_run_id, parent.id);
  assert.equal(row.held_reason, activeRunOnSlotReason(child.id));
});

for (const [what, blocked, message] of [
  [
    'a census hold',
    { held_reason: 'Process 4242 still uses the slot repository; slot teardown was skipped' },
    /remains occupied/,
  ],
  ['workspace recovery', { workspace_recovery: { step: 'reset' } }, /under workspace recovery/],
] as const)
  test(`${what} on the slot is refused before the prompt is sent`, async (t) => {
    const child = await chainedChild(t);
    row = { ...parentHold(child.id), ...blocked };
    sends.length = 0;
    await assert.rejects(handoff(child.id), message);
    assert.equal(sends.length, 0);
  });

test("the parent's pane is the child's recorded worker during the send, so a cancel stops it", async (t) => {
  const child = await chainedChild(t);
  row = parentHold(child.id);
  sends.length = 0;
  // The child is cancelled mid-send: its cleanup fences the slot it now owns.
  onSend = () => {
    row = { ...row, phase: 'releasing', releasing_since: '2026-11-25T03:00:00Z' };
    return { delivered: false };
  };
  const result = await handoff(child.id);
  assert.equal(result.handedOff, false);
  assert.equal(sends[0]?.worker_status, 'launching', 'the cancel finds the worker to stop');
  assert.equal(sends[0]?.worker_pane, '%7');
  assert.equal(row.phase, 'releasing', 'the give-back does not overwrite the cancel fence');
  assert.equal(row.current_run_id, child.id);
  const worker = store.getRun(child.id)?.agentContexts?.find((context) => context.role === 'dev');
  assert.equal(worker?.status, 'launching', 'the fenced cleanup still owns the worker record');
});

test('a send that lands and then fails to claim leaves the worker to the child cleanup', async (t) => {
  const child = await chainedChild(t);
  row = parentHold(child.id);
  // Another run reserves the slot during the send, so the claim after it is refused.
  onSend = () => {
    row = { ...row, handoff_run_id: 'rival' };
    return { delivered: true };
  };
  await assert.rejects(handoff(child.id), /reserved for another run/);
  assert.equal(row.current_run_id, child.id, 'the landed send keeps the slot with the child');
  const worker = store.getRun(child.id)?.agentContexts?.find((context) => context.role === 'dev');
  assert.equal(worker?.target?.pane, '%7', "the child's cleanup stops the parent's pane");
});

test("a send that throws gives the parent's hold back and keeps its own error", async (t) => {
  const child = await chainedChild(t);
  row = parentHold(child.id);
  const sendError = new Error('send transport failed');
  onSend = () => {
    throw sendError;
  };
  await assert.rejects(handoff(child.id), (error) => error === sendError);
  assert.equal(row.current_run_id, null);
  assert.equal(row.cleanup_run_id, parent.id);
  assert.equal(row.held_reason, activeRunOnSlotReason(child.id));
  const worker = store.getRun(child.id)?.agentContexts?.find((context) => context.role === 'dev');
  assert.equal(worker?.status, 'failed', "the pane is the parent's again");
});
