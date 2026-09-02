import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { ROOT } from '../lib/common.mjs';
import { writeEvidence } from '../lib/evidence.mjs';
import { ensureShellSession, killSession, sendShellScript } from '../lib/tmux.mjs';

export const SCENARIO_ID = 'warm-replacement-smoke';
export const RUNNER_AGNOSTIC = true;

function rpc(method, params = {}, timeoutMs = 120_000) {
  const script = path.join(ROOT, 'apps/command-center/scripts/cdp.mjs');
  const result = spawnSync('node', [script, 'gateway', method, JSON.stringify(params)], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: timeoutMs + 10_000,
    env: { ...process.env, FARMSLOT_RPC_TIMEOUT_MS: String(timeoutMs) },
  });
  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || result.stdout?.trim() || `${method} failed`);
  }
  return JSON.parse(result.stdout);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: 'utf8' });
  if (!options.ignoreFailure && result.status !== 0) {
    throw new Error(result.stderr?.trim() || result.stdout?.trim() || `${command} failed`);
  }
  return result;
}

async function poll(read, accept, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    latest = read();
    if (accept(latest)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out; latest=${JSON.stringify(latest)}`);
}

export async function runScenario({ timeoutMs, outDir }) {
  const id = `${process.pid}-${Date.now()}`;
  const project = `warm-replacement-${id}`;
  const slotId = project;
  const session = slotId;
  const projectDir = path.join(ROOT, 'projects', project);
  const poolFile = path.join(ROOT, 'pool', `${project}.json`);
  const repoDir = path.join(ROOT, 'temp', project, 'repo');
  const remoteDir = path.join(ROOT, 'temp', project, 'origin.git');
  let runId = null;
  let oldPid = null;
  let workerTaskDir = null;
  const report = {
    runner: 'scripted',
    slotId,
    runId: null,
    candidate: null,
    reservationObserved: false,
    prepareObservedStoppedRunner: false,
    oldRunnerWasLive: false,
    oldRunnerStopped: false,
    newPromptAccepted: false,
    failureProbeRejected: false,
    terminalStatus: null,
    terminalError: null,
    stepStates: null,
    pendingDecisions: null,
    pass: false,
    error: null,
  };

  try {
    fs.mkdirSync(projectDir, { recursive: true });
    fs.mkdirSync(repoDir, { recursive: true });
    fs.mkdirSync(path.join(projectDir, 'templates/worker'), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, 'project.json'),
      `${JSON.stringify(
        {
          name: project,
          paths: { runtime_dir: '.agent', artifact_dir: '.task' },
          scripted: { commands: { success: { command: 'true', timeout_ms: 10_000 } } },
        },
        null,
        2,
      )}\n`,
    );
    fs.writeFileSync(
      path.join(projectDir, 'templates/worker/dev.md'),
      '# Worker: dev\n\n## Task\n\nWarm replacement validation.\n',
    );
    fs.writeFileSync(
      poolFile,
      `${JSON.stringify(
        {
          machine: project,
          project,
          platform: 'cli',
          host: 'localhost',
          ssh_user: process.env.USER || 'dev',
          os: process.platform === 'darwin' ? 'darwin' : 'linux',
          slots: [{ id: slotId, enabled: true, repo: repoDir, session }],
        },
        null,
        2,
      )}\n`,
    );
    run('git', ['init', '-q', repoDir]);
    // The isolated checkout owns git/prepare state; symlinks expose only the
    // checkout-local scripted runner and temporary project configuration.
    for (const name of ['package.json', 'packages', 'projects', 'node_modules']) {
      fs.symlinkSync(path.join(ROOT, name), path.join(repoDir, name));
    }
    fs.writeFileSync(path.join(repoDir, 'README.md'), 'warm replacement validation\n');
    run('git', ['-C', repoDir, 'config', 'user.email', 'warm-replacement@example.invalid']);
    run('git', ['-C', repoDir, 'config', 'user.name', 'Warm Replacement']);
    run('git', [
      '-C',
      repoDir,
      'add',
      'README.md',
      'package.json',
      'packages',
      'projects',
      'node_modules',
    ]);
    run('git', ['-C', repoDir, 'commit', '-qm', 'init']);
    run('git', ['-C', repoDir, 'branch', '-M', 'main']);
    run('git', ['init', '--bare', '-q', remoteDir]);
    run('git', ['-C', repoDir, 'remote', 'add', 'origin', remoteDir]);
    run('git', ['-C', repoDir, 'push', '-qu', 'origin', 'main']);
    run('git', ['-C', repoDir, 'remote', 'set-head', 'origin', 'main']);
    killSession(session);
    const shell = ensureShellSession(session, repoDir);
    const oldRunnerName = `scripted-runner-${id}`;
    sendShellScript(shell.paneId, repoDir, [
      `bash -c 'bash -lc "exec -a ${oldRunnerName} sleep 300" & wait'`,
    ]);
    oldPid = await poll(
      () => run('pgrep', ['-f', `${oldRunnerName} 300`], { ignoreFailure: true }).stdout.trim(),
      (pid) => /^\d+$/.test(pid),
      10_000,
    );

    rpc('fleet.refresh');

    const candidates = await poll(
      () => rpc('dispatch.candidates', { project, flowType: 'dev', ticketOrPr: 'warm-smoke' }),
      (result) => result.candidates?.some((candidate) => candidate.slotId === slotId),
      20_000,
    );
    report.candidate = candidates.candidates.find((candidate) => candidate.slotId === slotId);
    if (!report.candidate?.replaceableWarm) throw new Error('slot was not replaceableWarm');
    report.oldRunnerWasLive = run('kill', ['-0', oldPid], { ignoreFailure: true }).status === 0;
    if (!report.oldRunnerWasLive)
      throw new Error('negative control runner exited before replacement');

    const projectConfigPath = path.join(projectDir, 'project.json');
    const projectConfig = JSON.parse(fs.readFileSync(projectConfigPath, 'utf8'));
    projectConfig.prepare = {
      default: 'proof',
      profiles: {
        proof: {
          label: 'Warm replacement ordering proof',
          phases: ['preflight'],
          hooks: {
            preflight: `if kill -0 ${oldPid} 2>/dev/null; then echo 'old runner alive during prepare' >&2; exit 42; fi`,
          },
        },
      },
    };
    fs.writeFileSync(projectConfigPath, `${JSON.stringify(projectConfig, null, 2)}\n`);

    try {
      rpc('dispatch.preview', {
        project,
        flowType: 'dev',
        ticketOrPr: 'TAT-999999',
        mode: 'validation',
        slotId,
      });
    } catch (error) {
      report.failureProbeRejected = String(error?.message || error).includes('Agent is working');
    }
    if (!report.failureProbeRejected) {
      throw new Error('negative preview did not reject working slot without freshReuse');
    }
    const positivePreview = rpc('dispatch.preview', {
      project,
      flowType: 'dev',
      ticketOrPr: 'TAT-999999',
      mode: 'validation',
      slotId,
      freshReuse: true,
      prepareProfile: 'proof',
    });
    if (positivePreview.preview?.slotId !== slotId) {
      throw new Error('fresh replacement preview did not accept the warm slot');
    }

    const created = rpc('run.create', {
      project,
      flowType: 'dev',
      ticketOrPr: 'TAT-999999',
      ticketData: {
        source: 'manual',
        title: 'Warm replacement validation',
        description: 'Temporary validation run',
        acceptanceCriteria: [],
        affectedArea: 'dispatch',
        stepsToReproduce: [],
        screenshots: [],
        labels: [],
      },
      mode: 'validation',
      runner: 'scripted',
      scripted: { mode: 'command', commandRef: 'success' },
      slotId,
      freshReuse: true,
      prepareProfile: 'proof',
    });
    runId = created.run.id;
    report.runId = runId;
    const done = await poll(
      () => rpc('run.get', { runId }).run,
      (runState) =>
        ['failed', 'blocked'].includes(runState.status) ||
        (['monitoring', 'done'].includes(runState.status) &&
          runState.steps.find((step) => step.name === 'dispatch')?.status === 'done'),
      timeoutMs,
    );
    report.terminalStatus = done.status;
    report.terminalError = done.error ?? null;
    report.stepStates = done.steps.map((step) => ({
      name: step.name,
      status: step.status,
      detail: step.detail ?? null,
    }));
    report.pendingDecisions = done.decisions
      .filter((decision) => !decision.resolvedAt)
      .map((decision) => ({ id: decision.id, type: decision.type }));
    if (done.status === 'failed' || done.status === 'blocked') {
      throw new Error(`replacement run ended ${done.status}: ${done.error ?? 'no error detail'}`);
    }
    report.reservationObserved =
      done.steps.find((step) => step.name === 'find-slot')?.outputs?.via === 'wizard-fresh-reuse';
    report.prepareObservedStoppedRunner =
      done.steps.find((step) => step.name === 'prepare')?.outputs?.success === true;
    report.oldRunnerStopped =
      Boolean(oldPid) && run('kill', ['-0', oldPid], { ignoreFailure: true }).status !== 0;
    const signalProbe = await poll(
      () => rpc('run.probeWorkerSignal', { runId }),
      (probe) => probe.signal?.status === 'complete',
      timeoutMs,
    );
    report.newPromptAccepted =
      done.steps.find((step) => step.name === 'dispatch')?.outputs?.success === true &&
      signalProbe.signal?.status === 'complete';
    const launchCommand = done.steps.find((step) => step.name === 'dispatch')?.outputs
      ?.launchCommand;
    const taskDirMatch =
      typeof launchCommand === 'string' ? launchCommand.match(/--task-dir '([^']+)'/) : null;
    workerTaskDir = taskDirMatch ? path.join(ROOT, taskDirMatch[1]) : null;
    report.pass =
      report.reservationObserved &&
      report.prepareObservedStoppedRunner &&
      report.oldRunnerStopped &&
      report.newPromptAccepted &&
      report.failureProbeRejected;
    if (!report.pass) throw new Error('replacement proof was incomplete');
  } catch (error) {
    report.error = error?.message || String(error);
  } finally {
    if (runId) {
      try {
        const current = rpc('run.get', { runId }).run;
        if (!['done', 'failed', 'cancelled'].includes(current.status)) {
          rpc('run.cancel', { runId, reason: 'warm replacement validation cleanup' });
        }
        rpc('run.delete', { runId });
      } catch (error) {
        report.error ??= `cleanup failed: ${error?.message || String(error)}`;
      }
    }
    killSession(session);
    fs.rmSync(poolFile, { force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(path.join(ROOT, 'temp', project), { recursive: true, force: true });
    if (workerTaskDir) fs.rmSync(workerTaskDir, { recursive: true, force: true });
    rpc('fleet.refresh');
  }

  const outPath = writeEvidence(report, SCENARIO_ID, 'scripted', outDir);
  return { scenario: SCENARIO_ID, runner: 'scripted', outPath, pass: report.pass, report };
}
