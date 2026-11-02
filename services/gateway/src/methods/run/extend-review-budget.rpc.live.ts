// Opt-in scripted proof with authenticated RPC and disposable Git/slot state. No farm run.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Methods, type Run, type RunExtendReviewBudgetResult } from '@farmslot/protocol';

import { createNativeProofFixture } from '../../runtime/native-proof-fixture.live-support.js';

test(
  'a spent-budget failure can be extended over RPC before replaying its review',
  { timeout: 120_000 },
  async (t) => {
    const output = process.env.FARMSLOT_REVIEW_BUDGET_PROOF_OUT;
    assert.ok(output, 'set FARMSLOT_REVIEW_BUDGET_PROOF_OUT');
    await mkdir(output, { recursive: true });
    const root = await mkdtemp(path.join(os.tmpdir(), 'review-budget-rpc-'));
    for (const key of Object.keys(process.env))
      if (/^(FARMSLOT_|GIT_CONFIG)/.test(key) || key === 'TMUX' || key === 'TMUX_PANE')
        delete process.env[key];
    Object.assign(process.env, {
      NODE_TEST_CONTEXT: '1',
      GATEWAY_HOST: '127.0.0.1',
      FARMSLOT_ROOT: root,
      FARMSLOT_HOME: path.join(root, 'home'),
      FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
      FARMSLOT_POOL_DIR: path.join(root, 'pool'),
      FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
      FARMSLOT_TEST_STATUS_FILE: path.join(root, 'status.json'),
      FARMSLOT_HEAVY_WRITE_FLOOR_GB: '2',
      FARMSLOT_ENABLE_SCRIPTED_SCENARIOS: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    });
    const source = fileURLToPath(new URL('../../../../../', import.meta.url));
    for (const name of [
      'scripts',
      'packages',
      'services',
      'node_modules',
      'schemas',
      'package.json',
      'CLAUDE.md',
    ])
      await symlink(path.join(source, name), path.join(root, name));
    const repo = path.join(root, 'checkout'),
      project = 'budget-proof',
      slotId = 'budget-proof-slot';
    for (const name of ['checkout', 'pool', `projects/${project}`, 'bin'])
      await mkdir(path.join(root, name), { recursive: true });
    await writeFile(path.join(root, 'bin/tmux'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    process.env.PATH = path.join(root, 'bin') + ':' + process.env.PATH;
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
    git('init', '-q', '-b', 'owned-change');
    git('config', 'user.name', 'Fixture');
    git('config', 'user.email', 'fixture@example.invalid');
    git('config', 'commit.gpgsign', 'false');
    git('config', 'core.hooksPath', '/dev/null');
    await writeFile(path.join(repo, 'README.md'), 'Budget recovery proof.\n');
    git('add', '.');
    git('commit', '-qm', 'test: seed review budget proof');
    const headSha = git('rev-parse', 'HEAD');
    await writeFile(
      path.join(root, 'projects', project, 'project.json'),
      JSON.stringify({ name: project, hooks: {}, default_branch: 'main' }),
    );
    await writeFile(
      path.join(root, 'pool/local.json'),
      JSON.stringify({
        machine: os.hostname(),
        host: 'localhost',
        ssh_user: os.userInfo().username,
        project,
        platform: 'cli',
        slots: [{ id: slotId, repo, session: slotId }],
      }),
    );
    await writeFile(
      path.join(root, 'status.json'),
      JSON.stringify({
        checked_at: new Date().toISOString(),
        slots: [
          {
            slot: slotId,
            machine: os.hostname(),
            project,
            platform: 'cli',
            lifecycle: 'ready',
            phase: null,
            agent: 'idle',
            enabled: true,
            slot_epoch: 1,
            current_run_id: null,
          },
        ],
      }),
    );
    await import('../../runtime/mock-pty.test-support.js');
    const execution = await import('../../core/exec.js');
    const execute: typeof execution.execOnSlot = async (...args) => {
      if (/\btmux\b/.test(args[1])) return { exitCode: 1, stdout: '', stderr: '' };
      return execution.execOnSlot(...args);
    };
    mock.module('../../core/exec.js', { namedExports: { ...execution, execOnSlot: execute } });
    const core = await import('../../core/index.js');
    mock.module('../../core/index.js', { namedExports: { ...core, execOnSlot: execute } });
    const fixture = await createNativeProofFixture(t, root);
    const { createRun, getRun, updateRun, persistRunNow, runsDirectory } =
      await import('../../runs/store.js');
    const { updateSlotStatus, readSlotRow } = await import('../../core/index.js');
    const { admitReviewRound, assertReviewRoundAvailable, runReviewRoundBudget } =
      await import('../../review/review-round-budget.js');
    const { releaseCompletedRunSlot } = await import('./lifecycle-control.js');
    const { runScriptedRunner } =
      await import('../../../../../packages/cli/src/commands/scripted-runner.js');
    const run = createRun({
      project,
      flowType: 'dev',
      mode: 'autonomous',
      ticketOrPr: 'TAT-4359',
      runner: 'scripted',
      slotId,
    });
    const task = path.join(root, 'projects', project, 'tasks/dev/budget');
    await mkdir(task, { recursive: true });
    await writeFile(path.join(task, 'TASK.md'), '# Scripted budget recovery\n');
    updateRun(run.id, {
      branch: 'owned-change',
      taskFile: path.join(task, 'TASK.md'),
      status: 'reviewing',
    });
    await updateSlotStatus(slotId, {
      current_run_id: run.id,
      lifecycle: 'busy',
      phase: 'review-gate',
      agent: 'idle',
    });
    assert.equal(
      await runScriptedRunner({
        taskDir: task,
        mode: 'scenario',
        scenario: 'success',
        stepDelayMs: 0,
      }),
      0,
    );
    assert.equal(
      JSON.parse(await readFile(path.join(task, 'SIGNAL.json'), 'utf8')).status,
      'complete',
    );
    for (let i = 0; i < 5; i++) await admitReviewRound(run.id, `spent-${i}`);
    // Use the real admission refusal and terminal release that produced the TAT-4359 state.
    let budgetError: Error | undefined;
    await assert.rejects(admitReviewRound(run.id, 'sixth-before-grant'), (error: Error) => {
      budgetError = error;
      return /five review rounds/.test(error.message);
    });
    assert.ok(budgetError);
    updateRun(run.id, { status: 'failed', error: budgetError.message });
    await persistRunNow(getRun(run.id)!);
    const release = await releaseCompletedRunSlot(getRun(run.id)!);
    assert.equal(release.released, true, JSON.stringify(release));
    assert.equal((await readSlotRow(slotId))?.current_run_id ?? null, null);
    assert.equal(git('rev-parse', 'HEAD'), headSha);
    assert.equal(git('branch', '--show-current'), 'owned-change');
    const connection = await fixture.client.connect();
    t.after(() => connection.close());
    const params = {
      runId: run.id,
      requestId: 'budget-recovery',
      expectedLimit: 5,
      limit: 7,
      headSha,
      scopeBrief: 'Review the scoped TAT-4359 correction and its regression proof.',
    };
    const refusalCases: string[] = [];
    for (const [name, owner, branch, requestHead] of [
      ['foreign-owner', 'another-run', 'owned-change', headSha],
      ['changed-branch', null, 'other-change', headSha],
      ['stale-head', null, 'owned-change', 'b'.repeat(40)],
    ] as const) {
      await updateSlotStatus(slotId, {
        current_run_id: owner,
        lifecycle: owner ? 'busy' : 'ready',
        phase: null,
      });
      git('checkout', '-q', '-B', branch);
      await assert.rejects(
        connection.call(Methods.RUN_EXTEND_REVIEW_BUDGET, {
          ...params,
          requestId: name,
          headSha: requestHead,
        }),
      );
      assert.equal(
        (await readSlotRow(slotId))?.current_run_id ?? null,
        owner,
        'refused grants do not take the slot',
      );
      assert.equal(getRun(run.id)!.reviewBudgetExtensions, undefined);
      refusalCases.push(name);
    }
    git('checkout', '-q', 'owned-change');
    const granted = await connection.call<RunExtendReviewBudgetResult>(
      Methods.RUN_EXTEND_REVIEW_BUDGET,
      params,
    );
    assert.equal(granted.run.status, 'failed', 'grant alone launches no reviewer or replay');
    assert.equal(granted.budget.used, 5);
    assert.equal(granted.budget.remaining, 2);
    assert.equal(granted.receipt.headSha, headSha);
    assert.equal((await readSlotRow(slotId))?.current_run_id, run.id);
    const disk = JSON.parse(await readFile(path.join(runsDirectory(), `${run.id}.json`), 'utf8'));
    assert.deepEqual(disk.reviewBudgetExtensions, [granted.receipt]);
    const replay = await connection.call<RunExtendReviewBudgetResult>(
      Methods.RUN_EXTEND_REVIEW_BUDGET,
      params,
    );
    assert.deepEqual(replay.receipt, granted.receipt);
    await assertReviewRoundAvailable(getRun(run.id)!);
    await admitReviewRound(run.id, 'sixth-after-grant');
    // The scripted harness represents the next admitted turn; no model or live farm is used.
    assert.equal(
      await runScriptedRunner({
        taskDir: path.join(task, 'sixth'),
        mode: 'scenario',
        scenario: 'success',
        stepDelayMs: 0,
      }),
      0,
    );
    const budget = await runReviewRoundBudget(getRun(run.id)!);
    assert.deepEqual([budget.used, budget.limit, budget.remaining], [6, 7, 1]);
    const readback = await connection.call<{ run: Run }>(Methods.RUN_GET, { runId: run.id });
    assert.deepEqual(readback.run.reviewBudgetExtensions, [granted.receipt]);
    await writeFile(
      path.join(output, 'proof.json'),
      JSON.stringify(
        {
          pass: true,
          runId: run.id,
          headSha,
          refusalCases,
          granted,
          budget,
          scriptedSignal: JSON.parse(await readFile(path.join(task, 'sixth/SIGNAL.json'), 'utf8')),
        },
        null,
        2,
      ) + '\n',
    );
  },
);
