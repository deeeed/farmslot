import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';

import '../../runtime/mock-pty.test-support.js';

const root = mkdtempSync(path.join(os.tmpdir(), 'retained-signature-'));
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
git('config', 'user.name', 'Retained signature proof');
git('config', 'user.email', 'signature@example.invalid');
git('config', 'core.hooksPath', '/dev/null');
git('config', 'commit.gpgsign', 'false');
git('commit', '-q', '--allow-empty', '-m', 'test: trusted main');
const main = git('rev-parse', 'HEAD');
git('update-ref', 'refs/remotes/origin/main', main);
const key = path.join(root, 'key');
execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key]);
git('config', 'gpg.format', 'ssh');
git('config', 'user.signingkey', key);
git('config', 'commit.gpgsign', 'true');
const slotId = 'retained-signature-proof';
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
writeFileSync(
  path.join(root, 'projects/proof/project.json'),
  JSON.stringify({ name: 'proof', default_branch: 'main' }),
);
const taskFile = path.join(root, 'tasks/pr-complete/proof/TASK.md');
writeFileSync(taskFile, '# Retained signature proof\n');
const store = await import('../../runs/store.js');
const core = await import('../../core/index.js');
mock.module('../../core/index.js', {
  namedExports: {
    ...core,
    readSlotField: async (_slot: string, field: string) =>
      ({ runner: 'claude', model: 'opus', current_flow_type: 'dev' })[field] ?? null,
  },
});
const tmux = await import('../../core/tmux.js');
mock.module('../../core/tmux.js', {
  namedExports: { ...tmux, resolveTmuxSession: async () => 'proof' },
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
const STOP = new Error('Fixture reached retained delivery boundary');
const execute = await import('./execute.js');
mock.module('./execute.js', {
  namedExports: {
    ...execute,
    ensureWorkerRoleTarget: async () => 'proof:dev.0',
    isRunnerAliveInAnyPane: async () => true,
    enforceDispatchPressureGate: async () => {
      throw STOP;
    },
  },
});
const warmModule: string = './warm-session-handoff.js?signing-baseline';
const nudgeModule: string = './nudge.js?signing-baseline';
const { warmSessionHandoffDispatch } = (await import(
  warmModule
)) as typeof import('./warm-session-handoff.js');
const { nudgeDispatch } = (await import(nudgeModule)) as typeof import('./nudge.js');
const { verifyWorkerPushedBranch } = await import('../../run-engine/push-verification.js');

for (const mode of ['warm', 'nudge'] as const) {
  test(`${mode} PR delivery records inherited history before completion checks new worker commits`, async (t) => {
    git('update-ref', 'HEAD', main);
    git(
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'test: inherited published author',
    );
    const inherited = git('rev-parse', 'HEAD');
    git('update-ref', 'refs/remotes/origin/feature', inherited);
    const run = store.createRun({
      flowType: 'pr-complete',
      project: 'proof',
      ticketOrPr: 'example/repo#1',
      runner: 'claude',
    });
    store.updateRun(run.id, { slotId, taskFile, branch: 'feature', prNumber: 1 });
    t.after(async () => {
      store.updateRun(run.id, { status: 'done' });
      await store.deleteRun(run.id);
    });
    const delivery =
      mode === 'warm'
        ? warmSessionHandoffDispatch(
            {
              slotId,
              taskFile,
              runId: run.id,
              ticketOrPr: 'example/repo#1',
              flowType: 'pr-complete',
            },
            () => undefined,
          )
        : nudgeDispatch(
            {
              slotId,
              taskFile,
              runId: run.id,
              ticketOrPr: 'example/repo#1',
              flowType: 'pr-complete',
              targetBranch: 'feature',
            },
            () => undefined,
          );
    await assert.rejects(delivery, (error) => error === STOP);
    assert.equal(store.getRun(run.id)?.worktreeHeadAtDispatch, inherited);
    git('commit', '-q', '--allow-empty', '-m', 'test: signed worker fix');
    git('update-ref', 'refs/remotes/origin/feature', 'HEAD');
    assert.equal((await verifyWorkerPushedBranch(run.id, slotId)).verified, true);
    git(
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'test: unsigned new worker fix',
    );
    await assert.rejects(verifyWorkerPushedBranch(run.id, slotId), /Unsigned outgoing commit/);
  });
}

test('retained replay preserves an existing before-work baseline', async (t) => {
  const run = store.createRun({
    flowType: 'pr-complete',
    project: 'proof',
    ticketOrPr: 'example/repo#1',
    runner: 'claude',
  });
  store.updateRun(run.id, { slotId, prNumber: 1, worktreeHeadAtDispatch: main });
  t.after(async () => {
    store.updateRun(run.id, { status: 'done' });
    await store.deleteRun(run.id);
  });
  const { recordRetainedPrBaseline } = await import('./worktree-baseline.js');
  await recordRetainedPrBaseline(run.id, await core.loadSlotVars(slotId));
  assert.equal(store.getRun(run.id)?.worktreeHeadAtDispatch, main);
});

test('unreadable retained PR checkout refuses delivery without inventing a baseline', async (t) => {
  const run = store.createRun({
    flowType: 'pr-complete',
    project: 'proof',
    ticketOrPr: 'example/repo#1',
    runner: 'claude',
  });
  store.updateRun(run.id, { slotId, prNumber: 1 });
  t.after(async () => {
    store.updateRun(run.id, { status: 'done' });
    await store.deleteRun(run.id);
  });
  const { recordRetainedPrBaseline } = await import('./worktree-baseline.js');
  await assert.rejects(
    recordRetainedPrBaseline(run.id, {
      ...(await core.loadSlotVars(slotId)),
      remoteRepo: path.join(root, 'missing'),
    }),
    /Cannot capture the inherited PR head/,
  );
  assert.equal(store.getRun(run.id)?.worktreeHeadAtDispatch, undefined);
});

for (const mode of ['warm', 'nudge'] as const) {
  test(`${mode} refuses an unsigned unpublished commit inherited from the prior worker`, async (t) => {
    git('update-ref', 'HEAD', main);
    git(
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'test: published author history',
    );
    git('update-ref', 'refs/remotes/origin/feature', 'HEAD');
    const unsigned = git(
      'commit-tree',
      git('rev-parse', 'HEAD^{tree}'),
      '-p',
      git('rev-parse', 'HEAD'),
      '-m',
      'test: prior worker subject rewrite',
    );
    git('update-ref', 'HEAD', unsigned);
    const run = store.createRun({
      flowType: 'pr-complete',
      project: 'proof',
      ticketOrPr: 'example/repo#1',
      runner: 'claude',
    });
    store.updateRun(run.id, { slotId, taskFile, branch: 'feature', prNumber: 1 });
    t.after(async () => {
      store.updateRun(run.id, { status: 'done' });
      await store.deleteRun(run.id);
    });
    const delivery =
      mode === 'warm'
        ? warmSessionHandoffDispatch(
            {
              slotId,
              taskFile,
              runId: run.id,
              ticketOrPr: 'example/repo#1',
              flowType: 'pr-complete',
            },
            () => undefined,
          )
        : nudgeDispatch(
            {
              slotId,
              taskFile,
              runId: run.id,
              ticketOrPr: 'example/repo#1',
              flowType: 'pr-complete',
              targetBranch: 'feature',
            },
            () => undefined,
          );
    await assert.rejects(delivery, (error: Error) =>
      error.message.includes(`Unsigned outgoing commit(s): ${unsigned.slice(0, 12)}`),
    );
    assert.equal(store.getRun(run.id)?.worktreeHeadAtDispatch, undefined);
  });
}
