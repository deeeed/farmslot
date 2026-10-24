// Opt-in control-plane proof. Engine launch stays disabled; dispatch consumption has its own regression.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { hostname, userInfo } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  Methods,
  type Run,
  type RunActivateOnSlotResult,
  type RunReplayStepResult,
} from '@farmslot/protocol';

import { createNativeProofFixture } from '../../runtime/native-proof-fixture.live-support.js';

test(
  'slot activation records its original dispatch baseline over authenticated RPC and ordinary replay retires it',
  { timeout: 60_000 },
  async (t) => {
    assert.equal(process.env.FARMSLOT_ACTIVATION_BASELINE_LIVE, '1');
    const output = process.env.FARMSLOT_ACTIVATION_BASELINE_PROOF_OUT;
    assert.ok(output);
    const root = await mkdtemp('/tmp/activation-baseline-rpc-');
    const project = 'activation-proof';
    const slotId = 'activation-proof-slot';
    const repo = path.join(root, 'repo');
    const task = path.join(root, 'projects', project, 'tasks', 'proof', 'TASK.md');
    for (const directory of [
      'pool',
      'scripts',
      'services/gateway',
      `projects/${project}/tasks/proof`,
      'repo',
      'bin',
    ])
      await mkdir(path.join(root, directory), { recursive: true });
    await writeFile(path.join(root, 'CLAUDE.md'), '# Disposable activation proof\n');
    await writeFile(path.join(root, 'scripts/dev.sh'), '#!/bin/sh\nexit 1\n');
    await writeFile(path.join(root, 'services/gateway/package.json'), '{}');
    await writeFile(path.join(root, 'bin/tmux'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    process.env.PATH = path.join(root, 'bin') + path.delimiter + process.env.PATH;
    process.env.FARMSLOT_HOME = path.join(root, 'home');
    process.env.FARMSLOT_DISPATCH_PRESSURE_ADMISSION = 'off';
    delete process.env.TMUX;
    delete process.env.TMUX_PANE;
    const git = (...args: string[]) =>
      execFileSync('git', args, {
        cwd: repo,
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'Fixture',
          GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
          GIT_COMMITTER_NAME: 'Fixture',
          GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
        },
      }).trim();
    git('init', '-q', '-b', 'main');
    await writeFile(path.join(repo, 'value.txt'), 'baseline');
    git('add', 'value.txt');
    git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'Fixture baseline');
    const baseline = git('rev-parse', 'HEAD');
    git('update-ref', 'refs/remotes/origin/main', baseline);
    git('switch', '-qc', 'feature');
    await writeFile(path.join(repo, 'value.txt'), 'recovered head');
    git('add', 'value.txt');
    git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'Fixture recovered head');
    const currentHead = git('rev-parse', 'HEAD');
    assert.notEqual(baseline, currentHead);
    await writeFile(task, '# Worker: dev\n\n**Branch:** feature\n');
    await writeFile(
      path.join(root, 'projects', project, 'project.json'),
      JSON.stringify({ name: project, default_branch: 'main', hooks: {} }),
    );
    await writeFile(
      path.join(root, 'pool/fixture.json'),
      JSON.stringify({
        machine: hostname(),
        host: 'localhost',
        ssh_user: userInfo().username,
        os: process.platform,
        platform: 'cli',
        project,
        slots: [{ id: slotId, enabled: true, mode: 'dispatch', repo, session: slotId }],
      }),
    );
    await writeFile(
      path.join(root, '.farm-status.json'),
      JSON.stringify({
        slots: [
          {
            slot: slotId,
            machine: hostname(),
            project,
            platform: 'cli',
            lifecycle: 'ready',
            phase: null,
            agent: 'idle',
            slot_epoch: 1,
          },
        ],
      }),
    );
    const fixture = await createNativeProofFixture(t, root);
    const { createRun, deleteRun, getRun, runsDirectory, updateRun } =
      await import('../../runs/store.js');
    const { updateSlotStatus } = await import('../../core/index.js');
    const run = createRun({
      flowType: 'dev',
      project,
      ticketOrPr: 'PROJ-4200',
      slotId,
      runner: 'scripted',
      model: 'fixture',
      transport: 'tmux',
    });
    try {
      updateRun(run.id, {
        recordedEvidenceContractVersion: 0,
        status: 'failed',
        taskFile: task,
        branch: 'feature',
        worktreeHeadAtDispatch: baseline,
        steps: run.steps.map((step) =>
          ['find-slot', 'write-task'].includes(step.name)
            ? {
                ...step,
                status: 'done',
                ...(step.name === 'write-task' ? { outputs: { taskFile: task } } : {}),
              }
            : step,
        ),
      });
      await updateSlotStatus(slotId, {
        current_run_id: run.id,
        lifecycle: 'ready',
        phase: null,
        agent: 'idle',
        slot_epoch: 1,
      });
      const activated = await fixture.client.call<RunActivateOnSlotResult>(
        Methods.RUN_ACTIVATE_ON_SLOT,
        { runId: run.id, slotId },
      );
      assert.equal(activated.run.worktreeHeadAtDispatch, baseline);
      const record = await fixture.client.call<{ run: Run }>(Methods.RUN_GET, { runId: run.id });
      assert.equal(
        record.run.steps.find((step) => step.name === 'dispatch')?.inputs
          ?.activationDispatchBaseline,
        baseline,
      );
      const persisted: Run = JSON.parse(
        await readFile(path.join(runsDirectory(), `${run.id}.json`), 'utf8'),
      );
      assert.equal(
        persisted.steps.find((step) => step.name === 'dispatch')?.inputs
          ?.activationDispatchBaseline,
        baseline,
      );
      assert.equal(git('rev-parse', 'HEAD'), currentHead);
      const ordinary = await fixture.client.call<RunReplayStepResult>(Methods.RUN_REPLAY_STEP, {
        runId: run.id,
        stepName: 'prepare',
        skipPrepare: false,
        triggeredBy: 'operator',
      });
      assert.equal(
        ordinary.run.steps.find((step) => step.name === 'dispatch')?.inputs
          ?.activationDispatchBaseline,
        undefined,
      );
      assert.equal(git('rev-parse', 'HEAD'), currentHead);
      await writeFile(
        output,
        JSON.stringify(
          {
            status: 'PASS',
            runId: run.id,
            baseline,
            currentHead,
            activationIntentPersisted: true,
            ordinaryPrepareIntentCleared: true,
            checkoutUnchanged: true,
            engineLaunchDisabled: true,
            dispatchConsumer: 'red/green production dispatch regression before worker launch',
            productOperations: [],
            root,
          },
          null,
          2,
        ) + '\n',
      );
    } finally {
      if (getRun(run.id)) {
        updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
        await deleteRun(run.id);
      }
    }
  },
);
