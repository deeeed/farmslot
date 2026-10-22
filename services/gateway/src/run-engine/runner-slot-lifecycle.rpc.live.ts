// Opt-in post-dispatch proof. One real Haiku worker, private gateway/root and no product slots.
// Run with NODE_TEST_CONTEXT=1 and --import tsx --test. The existing native fixture owns teardown.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { hostname, tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { Run } from '@farmslot/protocol';

import { createNativeProofFixture } from '../runtime/native-proof-fixture.live-support.js';

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean, label: string) {
  const deadline = Date.now() + 120_000;
  for (;;) {
    const value = await read();
    if (accept(value)) return value;
    assert.ok(Date.now() < deadline, label);
    await pause(100);
  }
}

test(
  'operator wait and cancelled-slot reclamation over the real native worker and RPC controls',
  { timeout: 240_000 },
  async (t) => {
    assert.equal(process.env.FARMSLOT_RUNNER_SLOT_LIVE, '1', 'opt in to one Haiku turn');
    const root = await mkdtemp(path.join(tmpdir(), 'runner-slot-native-'));
    const repo = path.join(root, 'repo'),
      project = 'runner-slot-proof',
      slotId = 'runner-slot-proof-slot';
    const out = process.env.FARMSLOT_RUNNER_SLOT_PROOF_OUT;
    assert.ok(out, 'set a retained evidence directory');
    await mkdir(out, { recursive: true });
    const save = (name: string, value: unknown) =>
      writeFile(path.join(out, name), JSON.stringify(value, null, 2) + '\n');
    const controller = new AbortController();
    let monitoring: Promise<unknown> | undefined;
    let stopWorker: (() => Promise<void>) | undefined;
    t.after(async () => {
      controller.abort();
      await monitoring;
      await stopWorker?.();
      try {
        await save('native-host.log.json', {
          log: await readFile(path.join(root, 'native/host.log'), 'utf8'),
        });
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
    });
    for (const dir of [repo, path.join(root, 'pool'), path.join(root, 'projects', project)])
      await mkdir(dir, { recursive: true });
    await mkdir(path.join(root, 'scripts'), { recursive: true });
    await mkdir(path.join(root, 'services/gateway'), { recursive: true });
    await writeFile(path.join(root, 'CLAUDE.md'), '# Disposable fixture\n');
    await writeFile(path.join(root, 'scripts/dev.sh'), '#!/bin/sh\nexit 1\n');
    await writeFile(path.join(root, 'services/gateway/package.json'), '{}');
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
    git('init', '-q', '-b', 'main');
    await writeFile(path.join(repo, 'README.md'), 'Retain checkout.\n');
    git('add', '.');
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-qm',
      'test: seed fixture',
    );
    const head = git('rev-parse', 'HEAD');
    await writeFile(
      path.join(root, 'projects', project, 'project.json'),
      JSON.stringify({
        name: project,
        hooks: {},
        review: { enabled: false },
        monitoring: {
          poll_interval_min: 1 / 60,
          stuck_timeout_min: 1 / 60,
          total_timeout_min: 1 / 60,
          max_nudges: 0,
        },
      }),
    );
    await writeFile(
      path.join(root, 'pool', 'fixture.json'),
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
        checked_at: new Date().toISOString(),
        slots: [
          {
            slot: slotId,
            machine: hostname(),
            project,
            platform: 'cli',
            lifecycle: 'ready',
            slot_epoch: 1,
            current_run_id: null,
          },
        ],
      }),
    );
    delete process.env.TMUX;
    delete process.env.TMUX_PANE;
    process.env.TMUX_TMPDIR = path.join(root, 'tmux');
    await mkdir(process.env.TMUX_TMPDIR, { recursive: true });
    const fixture = await createNativeProofFixture(t, root);
    const { createRun, updateRun, persistRunNow, getRun } = await import('../runs/store.js');
    const { updateSlotStatus, readSlotRow } = await import('../core/index.js');
    const { nativeSessionManager } = await import('../runners/native/manager.js');
    const { nativeWorkerLaunchDigest } =
      await import('../../../../packages/agent-runtime/src/native/worker-launch.js');
    const { monitorRun } = await import('./run-monitor.js');
    const { previewWhenSlotClaimable } = await import('./find-slot-step.js');
    const first = createRun(
      {
        project,
        flowType: 'dev',
        mode: 'interactive',
        devInteractiveProfile: 'lightweight',
        ticketOrPr: 'DEV-RUNNER-SLOT-PROOF',
        slotId,
        runner: 'claude',
        model: 'haiku',
        transport: 'native',
      },
      { nativeOwnerPrincipalId: fixture.person.id },
    );
    await updateSlotStatus(slotId, {
      lifecycle: 'busy',
      phase: 'working',
      current_run_id: first.id,
      agent: 'working',
    });
    assert.equal(
      (await readSlotRow(slotId))?.current_run_id,
      first.id,
      'fixture owns slot before spending a model turn',
    );
    // This fixture starts at MONITOR, avoiding unrelated task pin installation. Its
    // worker is real; no worker state or completion signal is fabricated.
    const launch = {
      leaseId: randomUUID(),
      safetyTier: 'full-auto' as const,
      environment: { set: {}, unset: ['JIRA_API_TOKEN', 'CONSENSYS_ATLASSIAN_API_TOKEN'] },
    };
    // Source-mode native hosts can still be importing when the client's 10s
    // startup wait ends. Warm the private host before any worker launch request.
    let startupError: unknown;
    try {
      await nativeSessionManager.list(fixture.person.id);
    } catch (error) {
      startupError = error;
    }
    const { existsSync } = await import('node:fs');
    await until(
      async () => existsSync(path.join(root, 'native/ready.json')),
      Boolean,
      `Private host did not become ready: ${String(startupError)}`,
    );
    const info = await nativeSessionManager.ensureWorker(
      fixture.person.id,
      { sessionId: randomUUID(), runner: 'claude', model: 'haiku', cwd: repo },
      launch,
    );
    const target = { sessionId: info.id, generation: info.generation, leaseId: launch.leaseId };
    stopWorker = async () => {
      await nativeSessionManager.closeWorker(fixture.person.id, target);
    };
    const commandId = randomUUID();
    const sent = await nativeSessionManager.sendWorker(
      fixture.person.id,
      target,
      commandId,
      'Reply READY only, then wait. Do not use tools, edit files or contact other services.',
    );
    assert.ok(sent.accepted || sent.submitted || sent.queued);
    await until(
      async () => {
        const snapshot = await nativeSessionManager.readWorker(
          fixture.person.id,
          info.id,
          launch.leaseId,
        );
        if (
          snapshot.commands.some(
            (command) => command.commandId === commandId && command.state === 'failed',
          )
        ) {
          await save('failed-command.json', snapshot);
        }
        return snapshot;
      },
      (snapshot) => {
        const receipt = snapshot.commands.find((command) => command.commandId === commandId);
        if (receipt?.state === 'failed') {
          assert.fail('Haiku native command failed; see failed-command.json');
        }
        return Boolean(receipt?.accepted);
      },
      'Haiku prompt acceptance',
    );
    const task = path.join(root, 'projects', project, 'tasks', 'dev', 'allocation', 'TASK.md');
    await mkdir(path.dirname(task), { recursive: true });
    await writeFile(task, '# Operator-owned allocation\n');
    const at = new Date().toISOString();
    updateRun(first.id, {
      status: 'monitoring',
      taskFile: task,
      steps: first.steps.map((step) => ({
        ...step,
        status:
          step.name === 'monitor'
            ? 'running'
            : step.name === 'review' || step.name === 'complete'
              ? 'pending'
              : 'done',
      })),
      agentContexts: [
        {
          id: 'dev',
          role: 'dev',
          label: 'Worker',
          runner: 'claude',
          model: 'haiku',
          runId: first.id,
          slotId,
          status: 'working',
          taskFile: task,
          nativeSession: {
            ...target,
            ownerPrincipalId: fixture.person.id,
            executionNodeId: 'local',
            commandId,
            stateDirectory: nativeSessionManager.workerStateDirectory(fixture.person.id, info.id),
            launchDigest: nativeWorkerLaunchDigest(launch),
            launchRequestedAt: at,
            acceptedAt: at,
          },
        },
      ],
    });
    await persistRunNow(getRun(first.id)!, 'live fixture dispatched identity');
    await updateSlotStatus(slotId, {
      lifecycle: 'busy',
      phase: 'working',
      current_run_id: first.id,
      agent: 'working',
    });
    monitoring = monitorRun(first.id, slotId, controller.signal);
    stopWorker = async () => {
      const current = getRun(first.id);
      if (current && !['cancelled', 'done', 'failed'].includes(current.status)) {
        await fixture.client.call('run.cancel', { runId: first.id, reason: 'Fixture cleanup' });
      }
    };
    const read = async () =>
      (await fixture.client.call<{ run: Run }>('run.get', { runId: first.id })).run;
    await until(read, (run) => Boolean(run.waitingForOperator), 'operator wait was not projected');
    const waitedAt = Date.now();
    await until(
      read,
      (run) => {
        assert.equal(run.status, 'monitoring');
        assert.equal(run.metrics.nudgeCount, 0);
        assert.equal(run.decisions.filter((d) => !d.resolvedAt).length, 0);
        return Date.now() - waitedAt > 4000;
      },
      'wait past the inactivity limit',
    );
    await save('operator-wait.json', await read());
    await save(
      'cancelled.json',
      await fixture.client.call('run.cancel', { runId: first.id, reason: 'Fixture cancellation' }),
    );
    await monitoring;
    assert.equal(
      (await readSlotRow(slotId))?.current_run_id,
      first.id,
      'cancel alone retains replay',
    );
    const requester = createRun({
      project,
      flowType: 'dev',
      mode: 'interactive',
      ticketOrPr: 'DEV-RUNNER-SLOT-REQUESTER',
      slotId,
    });
    updateRun(requester.id, { status: 'slot-finding' });
    // This is the production pinned find-slot admission path; RPC reads prove its
    // effect while no later prepare can change the preserved checkout.
    await previewWhenSlotClaimable(requester.id, 0, slotId, async () => readSlotRow(slotId));
    assert.equal((await readSlotRow(slotId))?.current_run_id, null);
    assert.equal((await read()).slotReclaimed?.byRunId, requester.id);
    await assert.rejects(
      fixture.client.call('run.replayStep', { runId: first.id, stepName: 'monitor' }),
      /slot .* was reclaimed by run/,
    );
    assert.equal(git('rev-parse', 'HEAD'), head);
    assert.equal(await readFile(path.join(repo, 'README.md'), 'utf8'), 'Retain checkout.\n');
    await save('reclaimed.json', await read());
    await fixture.client.call('run.cancel', { runId: requester.id, reason: 'Fixture cleanup' });
    await fixture.client.call('run.archive', { runId: requester.id });
    await fixture.client.call('run.archive', { runId: first.id });
    await save('result.json', {
      pass: true,
      model: 'haiku',
      runs: [first.id, requester.id],
      checks: [
        'Real worker identity with native acceptance',
        'Operator wait has zero nudges past configured inactivity/timeout',
        'Cancel retains replay until pinned selection needs capacity',
        'Confirmed cleanup frees ownership and preserves HEAD/files/evidence',
        'Old replay refuses with the reclaiming run identity',
      ],
      scope:
        'Post-dispatch fixture; hosted task-init excluded because its immutable distribution copy exceeded 120 seconds in the separate dispatch proof.',
    });
  },
);

test(
  'the real Pi auth command refuses an empty isolated provider profile before dispatch',
  { timeout: 45_000 },
  async (t) => {
    assert.equal(process.env.FARMSLOT_RUNNER_SLOT_LIVE, '1');
    const directory = await mkdtemp(path.join(tmpdir(), 'runner-auth-live-'));
    const { rm } = await import('node:fs/promises');
    t.after(() => rm(directory, { recursive: true, force: true }));
    const piPath = execFileSync('which', ['pi'], { encoding: 'utf8' }).trim();
    // The first fixture removes its private root. A fresh process avoids reusing
    // that root's cached module constants when resolving the real auth helper.
    const sourceRoot = new URL('../../../../', import.meta.url).pathname;
    execFileSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `
      import assert from 'node:assert/strict';
      const { makeVars } = await import(${JSON.stringify(new URL('../runners/test-fixtures.js', import.meta.url).href)});
      const { assertRunnerAuthBeforeLaunch } = await import(${JSON.stringify(new URL('../runners/runner-auth.js', import.meta.url).href)});
      const { directory, piPath } = JSON.parse(process.argv[1]);
      const vars = makeVars({ piPath, repo: directory, remoteRepo: directory,
        machineEnv: { PI_CODING_AGENT_DIR: directory } });
      await assert.rejects(assertRunnerAuthBeforeLaunch(vars, 'pi', 'anthropic/claude-haiku-4-5', {
        command_env: { unset: ['ANTHROPIC_API_KEY', 'ANTHROPIC_OAUTH_TOKEN',
          'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'XAI_API_KEY'] },
      }), /authentication failed before dispatch: credentials_not_configured/);
    `,
        JSON.stringify({ directory, piPath }),
      ],
      {
        env: { ...process.env, FARMSLOT_ROOT: sourceRoot },
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30_000,
      },
    );
    const out = process.env.FARMSLOT_RUNNER_SLOT_PROOF_OUT;
    assert.ok(out);
    await mkdir(out, { recursive: true });
    await writeFile(
      path.join(out, 'pi-auth.json'),
      JSON.stringify({
        pass: true,
        provider: 'anthropic',
        status: 'credentials_not_configured',
        modelTurns: 0,
        credentialFilesReadOrChanged: false,
      }) + '\n',
    );
  },
);
