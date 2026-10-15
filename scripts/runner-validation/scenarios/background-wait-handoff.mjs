import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { ROOT, shSingleQuote, sleepMs, TMUX_SKILL } from '../lib/common.mjs';
import { writeEvidence } from '../lib/evidence.mjs';
import { runGatewayMonitorStuck } from '../lib/gateway-post-launch.mjs';
import { eventName, readHookLines } from '../lib/hooks.mjs';
import { installHooks, obsDirFor } from '../lib/install.mjs';
import { ensureShellSession, killSession, sendShellScript, tmux } from '../lib/tmux.mjs';
import { resolveLaunchBlockers } from '../lib/tmux-input.mjs';

export const SCENARIO_ID = 'background-wait-handoff';

// Manual live proof only. The delay creates a real background task, never a CI sleep.
const PROMPT =
  'Use Bash once to run "sleep 45" with run_in_background=true. Immediately end your turn without polling, waiting for, stopping, or reading that task. When the completion notification arrives, reply DONE without more tools.';

function monitorDecision(repo, target, phase) {
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      path.join(ROOT, 'scripts/runner-validation/gateway/background-wait-monitor.mts'),
      repo,
      target,
      phase,
    ],
    { cwd: ROOT, encoding: 'utf8', timeout: 30000, env: process.env },
  );
  if (result.status !== 0)
    throw new Error(result.stderr || result.stdout || 'Monitor proof failed');
  return JSON.parse(
    result.stdout
      .trim()
      .split('\n')
      .findLast((line) => line.startsWith('{')),
  );
}

export async function runScenario({ runnerAdapter, timeoutMs, outDir, via }) {
  const runner = runnerAdapter.RUNNER_ID;
  if (runner !== 'claude') {
    const report = {
      runner,
      skipped: true,
      pass: true,
      skipReason: 'Requires native background task notifications',
    };
    return {
      report,
      runner,
      scenario: SCENARIO_ID,
      pass: true,
      skipped: true,
      outPath: writeEvidence(report, SCENARIO_ID, runner, outDir),
    };
  }
  const scratch = fs.mkdtempSync('/tmp/fs-background-wait-');
  const repo = path.join(scratch, 'checkout');
  fs.mkdirSync(repo);
  const saved = {
    TMUX: process.env.TMUX,
    TMUX_TMPDIR: process.env.TMUX_TMPDIR,
    TMUX_MODEL_DRIVER_STATE_DIR: process.env.TMUX_MODEL_DRIVER_STATE_DIR,
  };
  delete process.env.TMUX;
  process.env.TMUX_TMPDIR = scratch;
  process.env.TMUX_MODEL_DRIVER_STATE_DIR = path.join(scratch, 'driver');
  const session = 'background-wait-proof';
  const stopTask = via === 'task-stop';
  const guard = path.join(scratch, 'keep-running');
  const pidFile = path.join(scratch, 'background.pid');
  const job = path.join(scratch, 'background.cjs');
  const processAlive = () => {
    if (!fs.existsSync(pidFile)) return false;
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('Invalid owned background PID');
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if (error.code === 'ESRCH') return false;
      throw error;
    }
  };
  let prompt = PROMPT;
  if (stopTask) {
    fs.writeFileSync(guard, 'owned live proof');
    fs.writeFileSync(
      job,
      `const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
const deadline = Date.now() + ${timeoutMs * 2 + 10000};
setInterval(() => {
  if (!fs.existsSync(${JSON.stringify(guard)}) || Date.now() > deadline) process.exit(0);
}, 100);
`,
    );
    prompt = `Use Bash once to run ${JSON.stringify(`${shSingleQuote(process.execPath)} ${shSingleQuote(job)}`)} with run_in_background=true. Immediately end your turn without polling, waiting for, stopping, or reading that task. Do not create any other background tasks.`;
  }
  const report = {
    runner,
    via: stopTask ? 'task-stop' : 'completion',
    scratch,
    session,
    active: null,
    settled: null,
    cleaned: false,
    pass: false,
  };
  try {
    installHooks(runner, repo, '.agent', 'background-wait-proof');
    const { paneId } = ensureShellSession(session, repo);
    const panePid = tmux(['display-message', '-p', '-t', paneId, '#{pane_pid}']);
    sendShellScript(paneId, repo, [
      runnerAdapter.buildInteractiveLaunchCommand(repo, '.agent', prompt),
    ]);
    resolveLaunchBlockers(paneId, runner, Math.min(timeoutMs, 30_000));
    const log = path.join(obsDirFor(repo, '.agent'), 'hooks.jsonl');
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (readHookLines(log).some((row) => eventName(row) === 'Stop')) {
        const probe = runGatewayMonitorStuck({ repo, target: paneId, runner, panePid });
        if (!probe.ok) throw new Error(probe.error);
        if (
          !report.active &&
          probe.turnState?.value === 'idle' &&
          probe.kind === 'making-progress' &&
          probe.runnerAlive &&
          !probe.wouldNudge
        ) {
          report.active = { ...probe, monitor: monitorDecision(repo, paneId, 'active') };
          if (stopTask) {
            if (!processAlive()) throw new Error('Owned background job is not alive');
            report.backgroundPid = Number(fs.readFileSync(pidFile, 'utf8'));
            const delivery = spawnSync(
              'bash',
              [path.join(TMUX_SKILL, 'send-and-verify.sh'), paneId, runner],
              {
                input:
                  'Use TaskStop once with the task_id of the background Bash task you just launched. End your turn immediately after its result. Do not launch or poll any other work.',
                encoding: 'utf8',
                timeout: 60000,
                env: process.env,
              },
            );
            report.stopDelivery = JSON.parse(delivery.stdout);
            if (delivery.status !== 0 || !report.stopDelivery.submitted)
              throw new Error('Native TaskStop instruction delivery was not verified');
          }
        }
        if (report.active && probe.kind === 'idle' && probe.stuck && probe.wouldNudge) {
          if (stopTask && processAlive()) continue;
          report.settled = {
            ...probe,
            ...(stopTask ? { backgroundProcessStopped: true } : {}),
            monitor: monitorDecision(repo, paneId, 'settled'),
            operatorWait: monitorDecision(repo, paneId, 'operator-wait'),
          };
          break;
        }
      }
      sleepMs(250);
    }
    if (!report.active || !report.settled)
      throw new Error(
        'Did not observe both stopped-turn/background-active and settled-idle states',
      );
    report.pass = true;
  } catch (error) {
    report.error = error.message;
  } finally {
    try {
      fs.rmSync(guard, { force: true });
      const cleanupDeadline = Date.now() + 5000;
      while (processAlive() && Date.now() < cleanupDeadline) sleepMs(100);
      if (processAlive()) {
        report.pass = false;
        report.error = 'Owned background job did not exit during cleanup';
      }
      report.driverReceipts = fs.existsSync(process.env.TMUX_MODEL_DRIVER_STATE_DIR)
        ? fs
            .readdirSync(process.env.TMUX_MODEL_DRIVER_STATE_DIR, { withFileTypes: true })
            .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
            .map((entry) => ({
              file: entry.name,
              content: fs.readFileSync(
                path.join(process.env.TMUX_MODEL_DRIVER_STATE_DIR, entry.name),
                'utf8',
              ),
            }))
        : [];
    } finally {
      try {
        killSession(session);
        fs.rmSync(scratch, { recursive: true, force: true });
        report.cleaned = true;
      } finally {
        for (const [key, value] of Object.entries(saved)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    }
  }
  return {
    report,
    runner,
    scenario: SCENARIO_ID,
    pass: report.pass,
    outPath: writeEvidence(report, SCENARIO_ID, runner, outDir),
  };
}
