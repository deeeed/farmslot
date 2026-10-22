// Opt-in control-plane proof: private run/slot, real mark engine and RPC, no model or product task.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer as createPortReservation } from 'node:net';
import { hostname, userInfo } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  Methods,
  type Run,
  type RunProbeWorkerSignalResult,
  type WorkerSignal,
} from '@farmslot/protocol';

import { createNativeProofFixture } from '../../runtime/native-proof-fixture.live-support.js';

test(
  'Resume reattaches a marked review-fix over RPC without restarting primary work',
  { timeout: process.env.FARMSLOT_BLOCKED_RESUME_UI === '1' ? 600_000 : 60_000 },
  async (t) => {
    assert.equal(process.env.FARMSLOT_BLOCKED_RESUME_LIVE, '1', 'opt in to the private RPC proof');
    const out = process.env.FARMSLOT_BLOCKED_RESUME_PROOF_OUT;
    assert.ok(out, 'retain the proof receipt outside its disposable fixture');
    await mkdir(out, { recursive: true });
    const root = await mkdtemp(path.join('/tmp', 'blocked-fix-resume-'));
    delete process.env.TMUX;
    delete process.env.TMUX_PANE;
    process.env.TMUX_TMPDIR = path.join(root, 'tmux');
    await mkdir(process.env.TMUX_TMPDIR, { recursive: true });
    const project = 'resume-proof',
      slotId = 'resume-proof-slot';
    const repo = path.join(root, 'repo'),
      relative = 'tasks/feat/resume';
    const gatewayTask = path.join(root, 'projects', project, relative);
    const task = path.join(repo, 'temp', relative);
    for (const dir of [
      repo,
      task,
      gatewayTask,
      path.join(root, 'pool'),
      path.join(root, 'scripts'),
      path.join(root, 'services/gateway'),
    ])
      await mkdir(dir, { recursive: true });
    await writeFile(path.join(root, 'CLAUDE.md'), '# Disposable proof\n');
    await writeFile(path.join(root, 'scripts/dev.sh'), '#!/bin/sh\nexit 1\n');
    await writeFile(path.join(root, 'services/gateway/package.json'), '{}');
    await writeFile(
      path.join(root, 'projects', project, 'project.json'),
      JSON.stringify({
        name: project,
        task_dir: 'temp/tasks',
        hooks: {},
        review: { enabled: false },
      }),
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
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
    git('init', '-q', '-b', 'main');
    await writeFile(path.join(repo, 'README.md'), 'Owned resume fixture.\n');
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
      'test: seed resume fixture',
    );
    await writeFile(path.join(task, 'TASK.md'), '# Primary task already delivered\n');
    await writeFile(path.join(gatewayTask, 'TASK.md'), '# Primary task already delivered\n');
    await writeFile(
      path.join(task, 'REVIEW-FIX.md'),
      '# Fix\n- [ ] Validate the operator-authorized build\n',
    );
    await writeFile(
      path.join(task, 'checklist-target.json'),
      JSON.stringify({ checklist: 'REVIEW-FIX.md', signal: 'REVIEW-FIX-SIGNAL.json' }),
    );
    const marker = fileURLToPath(
      new URL(
        '../../../../../packages/agent-runtime/scripts/mark-checklist-step.cjs',
        import.meta.url,
      ),
    );
    const mark = (attempt: string, ...args: string[]) =>
      execFileSync(process.execPath, [marker, task, ...args], {
        env: { ...process.env, FARMSLOT_SIGNAL_ATTEMPT_ID: attempt },
        encoding: 'utf8',
      });
    mark('blocked-fix', 'start');
    mark('blocked-fix', 'blocked', '--reason', 'Operator authority required', '--skip-learnings');
    const blocked: WorkerSignal = JSON.parse(
      await readFile(path.join(task, 'REVIEW-FIX-SIGNAL.json'), 'utf8'),
    );
    const fixture = await createNativeProofFixture(t, root);
    const { createRun, getRun, updateRun, persistRunNow } = await import('../../runs/store.js');
    const { updateSlotStatus } = await import('../../core/index.js');
    const { applyRunningWorkerSignalToContext } =
      await import('../../tasks/worker-signal-context.js');
    const run = createRun({
      project,
      flowType: 'dev',
      ticketOrPr: 'FIXTURE-1',
      slotId,
      runner: 'claude',
      model: 'haiku',
    });
    const { resolveWorkerTerminalContract } =
      await import('../../tasks/worker-terminal-contract.js');
    const contract = {
      ...resolveWorkerTerminalContract(null, run.flowType, { mode: run.mode }),
      recordedEvidenceContractVersion: run.recordedEvidenceContractVersion,
    };
    for (const directory of [gatewayTask, task]) {
      await mkdir(path.join(directory, 'inputs'), { recursive: true });
      await writeFile(
        path.join(directory, 'inputs/worker-terminal-contract.json'),
        JSON.stringify(contract),
      );
      await writeFile(
        path.join(directory, 'inputs/handoff.json'),
        JSON.stringify({ attemptId: run.id, project, flow: run.flowType }),
      );
    }
    const signalFile = path.join('temp', relative, 'REVIEW-FIX-SIGNAL.json');
    const fixTask = path.join('temp', relative, 'REVIEW-FIX.md');
    updateRun(run.id, {
      status: 'blocked',
      taskFile: path.join(gatewayTask, 'TASK.md'),
      agentContexts: [
        {
          id: 'review-fix',
          role: 'review-fix',
          runId: run.id,
          slotId,
          label: 'Review fix',
          status: 'blocked',
          taskFile: fixTask,
          signalFile,
          signalAttemptId: blocked.attemptId,
          attemptStartedAt: blocked.timestamp,
        },
      ],
      steps: run.steps.map((step) => ({
        ...step,
        status: 'done',
        ...(step.name === 'review'
          ? { completedAt: blocked.timestamp, outputs: { verdict: 'blocked', feedbackSent: true } }
          : step.name === 'monitor'
            ? {
                outputs: {
                  workerSignal: {
                    status: 'complete',
                    attemptId: 'primary-complete',
                    timestamp: blocked.timestamp,
                  },
                },
              }
            : {}),
      })),
    });
    await updateSlotStatus(slotId, {
      lifecycle: 'held',
      phase: 'pr-watch',
      current_run_id: run.id,
    });
    await persistRunNow(getRun(run.id)!, 'proof-blocked-fix');
    const initial = await fixture.client.call<RunProbeWorkerSignalResult>(
      Methods.RUN_PROBE_WORKER_SIGNAL,
      { runId: run.id },
    );
    assert.equal(initial.resumable, false);
    mark('resumed-fix', 'start');
    const signal: WorkerSignal = JSON.parse(
      await readFile(path.join(task, 'REVIEW-FIX-SIGNAL.json'), 'utf8'),
    );
    assert.equal(signal.status, 'running');
    await applyRunningWorkerSignalToContext(slotId, run.id, signal, 'review-fix', 'review-fix');
    const probe = await fixture.client.call<RunProbeWorkerSignalResult>(
      Methods.RUN_PROBE_WORKER_SIGNAL,
      { runId: run.id },
    );
    assert.equal(probe.resumable, true);
    assert.equal(probe.signalFile?.endsWith('REVIEW-FIX-SIGNAL.json'), true);
    const before = getRun(run.id)!;
    const uiProof = process.env.FARMSLOT_BLOCKED_RESUME_UI === '1';
    if (uiProof) {
      const { createServer } = await import('vite');
      process.env.GATEWAY_PORT = new URL(fixture.url).port;
      const reservation = createPortReservation();
      await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve));
      const available = reservation.address();
      assert.ok(available && typeof available !== 'string');
      await new Promise<void>((resolve, reject) =>
        reservation.close((error) => (error ? reject(error) : resolve())),
      );
      const ui = await createServer({
        configFile: fileURLToPath(
          new URL('../../../../../apps/command-center/ui/vite.config.ts', import.meta.url),
        ),
        server: { host: '127.0.0.1', port: available.port },
        logLevel: 'error',
      });
      t.after(() => ui.close());
      await ui.listen();
      const address = ui.httpServer?.address();
      assert.ok(address && typeof address !== 'string');
      await writeFile(
        path.join(root, 'gateways.json'),
        JSON.stringify({
          active: 'proof',
          gateways: {
            proof: { url: fixture.url, authMode: 'token', secret: fixture.browserCredential },
          },
        }),
        { mode: 0o600 },
      );
      await writeFile(
        path.join(out, 'ui-ready.json'),
        JSON.stringify(
          {
            root,
            gatewayUrl: fixture.url,
            uiUrl: `http://127.0.0.1:${address.port}`,
            runId: run.id,
          },
          null,
          2,
        ) + '\n',
      );
      const deadline = Date.now() + 480_000;
      while (getRun(run.id)?.status === 'blocked') {
        assert.ok(Date.now() < deadline, 'Click Resume worker on the isolated run through CDP');
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    } else {
      await fixture.client.call(Methods.RUN_RESUME, { runId: run.id });
    }
    const resumed = { run: getRun(run.id)! };
    assert.equal(resumed.run.status, 'reviewing');
    assert.equal(resumed.run.steps.find((step) => step.name === 'monitor')?.status, 'done');
    assert.deepEqual(
      resumed.run.steps.find((step) => step.name === 'monitor')?.outputs,
      before.steps.find((step) => step.name === 'monitor')?.outputs,
    );
    assert.equal(resumed.run.activeTaskFile, fixTask);
    assert.equal(
      await readFile(path.join(task, 'REVIEW-FIX-SIGNAL.json'), 'utf8'),
      JSON.stringify(signal, null, 2) + '\n',
    );
    const record = await fixture.client.call<{ run: Run }>(Methods.RUN_GET, { runId: run.id });
    assert.equal(record.run.status, 'reviewing');
    assert.equal(record.run.steps.find((step) => step.name === 'review')?.status, 'pending');
    assert.equal(record.run.agentContexts?.length, 1, 'no reviewer or replacement worker launched');
    if (uiProof) {
      const deadline = Date.now() + 90_000;
      for (;;) {
        try {
          await readFile(path.join(out, 'ui-complete'));
          break;
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
        }
        assert.ok(Date.now() < deadline, 'Capture the active run view after Resume');
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    await writeFile(
      path.join(out, 'rpc-result.json'),
      JSON.stringify(
        {
          status: 'PASS',
          runId: run.id,
          initialResumable: initial.resumable,
          resumedSignalFile: probe.signalFile,
          statusAfterResume: record.run.status,
          primaryPreserved: true,
          fixArtifactsPreserved: true,
          reviewOrWorkerLaunched: false,
          productRunChanged: false,
        },
        null,
        2,
      ) + '\n',
    );
  },
);
