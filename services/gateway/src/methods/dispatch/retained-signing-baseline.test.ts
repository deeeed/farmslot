import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, mock, test } from 'node:test';

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

test('nudge accepts a signed merge of unsigned publication-base history and still rejects new unsigned work', async (t) => {
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
  const published = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/remotes/origin/feature', published);
  git('update-ref', 'HEAD', main);
  git(
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'test: trusted new main',
  );
  const updatedMain = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/remotes/origin/main', updatedMain);
  const merged = git(
    'commit-tree',
    '-S',
    git('rev-parse', 'HEAD^{tree}'),
    '-p',
    published,
    '-p',
    updatedMain,
    '-m',
    'test: signed merge main',
  );
  git('update-ref', 'HEAD', merged);
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
  await assert.rejects(
    nudgeDispatch(
      {
        slotId,
        taskFile,
        runId: run.id,
        ticketOrPr: 'example/repo#1',
        flowType: 'pr-complete',
        targetBranch: 'feature',
      },
      () => undefined,
    ),
    (error) => error === STOP,
  );
  assert.equal(store.getRun(run.id)?.worktreeHeadAtDispatch, merged);
  git(
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'test: unsigned new contribution',
  );
  await assert.rejects(verifyWorkerPushedBranch(run.id, slotId), /Unsigned outgoing commit/);
});

describe('unfetched PR signature bases', () => {
  const branch = 'never-fetched-pr';
  let published = '';
  let signedHead = '';
  before(() => {
    const remote = path.join(root, 'unfetched-pr.git');
    git('init', '-q', '--bare', remote);
    git('remote', 'add', 'origin', remote);
    git('config', 'remote.origin.fetch', '+refs/heads/main:refs/remotes/origin/main');
    git('push', '-q', 'origin', `${main}:refs/heads/main`);
    git('update-ref', 'refs/remotes/origin/main', main);
    git('checkout', '-q', '-B', 'previous-finished-task', main);
    git(
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'test: published PR author',
    );
    published = git('rev-parse', 'HEAD');
    git('push', '-q', 'origin', `${published}:refs/heads/${branch}`);
    git('reset', '--hard', main);
    git('commit', '-q', '--allow-empty', '-m', 'test: signed previous task');
    signedHead = git('rev-parse', 'HEAD');
    assert.equal(git('for-each-ref', '--format=%(refname)', `refs/remotes/origin/${branch}`), '');
  });
  after(() => git('remote', 'remove', 'origin'));

  async function pendingRun(t: test.TestContext, target: string) {
    const run = store.createRun({
      flowType: 'update-branch',
      project: 'proof',
      ticketOrPr: 'example/repo#138',
    });
    store.updateRun(run.id, { slotId, branch: target, prNumber: 138 });
    t.after(async () => {
      store.updateRun(run.id, { status: 'done' });
      await store.deleteRun(run.id);
    });
    const { recordRetainedPrBaseline } = await import('./worktree-baseline.js');
    const vars = await core.loadSlotVars(slotId);
    return { run, record: () => recordRetainedPrBaseline(run.id, vars) };
  }

  test('update-branch fetches a never-fetched PR ref before capturing its inherited baseline', async (t) => {
    const f = await pendingRun(t, branch);
    await f.record();
    assert.equal(git('rev-parse', `refs/remotes/origin/${branch}`), published);
    assert.equal(git('branch', '--show-current'), 'previous-finished-task');
    assert.equal(git('rev-parse', 'HEAD'), signedHead);
    assert.equal(store.getRun(f.run.id)?.worktreeHeadAtDispatch, signedHead);
  });

  test('fetching an unfetched PR ref still refuses unsigned local work without a baseline', async (t) => {
    git('update-ref', '-d', `refs/remotes/origin/${branch}`);
    git(
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'test: unsigned inherited work',
    );
    const before = git('rev-parse', 'HEAD');
    const f = await pendingRun(t, branch);
    await assert.rejects(f.record(), /Unsigned outgoing commit/);
    assert.equal(git('rev-parse', `refs/remotes/origin/${branch}`), published);
    assert.equal(git('rev-parse', 'HEAD'), before);
    assert.equal(store.getRun(f.run.id)?.worktreeHeadAtDispatch, undefined);
  });

  test('an unavailable PR branch names the fetch refusal and does not capture a baseline', async (t) => {
    const before = git('rev-parse', 'HEAD');
    const f = await pendingRun(t, 'unavailable-pr');
    await assert.rejects(
      f.record(),
      /Cannot fetch PR branch unavailable-pr before checking inherited commit signatures/,
    );
    assert.equal(git('rev-parse', 'HEAD'), before);
    assert.equal(store.getRun(f.run.id)?.worktreeHeadAtDispatch, undefined);
  });

  test('disabled signing still skips remote-ref requirements', async (t) => {
    git('config', 'commit.gpgsign', 'false');
    t.after(() => git('config', 'commit.gpgsign', 'true'));
    const before = git('rev-parse', 'HEAD');
    const f = await pendingRun(t, 'not-fetched-signing-off');
    await f.record();
    assert.equal(store.getRun(f.run.id)?.worktreeHeadAtDispatch, before);
  });
});
