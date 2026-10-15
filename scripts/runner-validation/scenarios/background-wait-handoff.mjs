import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { ROOT, sleepMs } from '../lib/common.mjs';
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

export async function runScenario({ runnerAdapter, timeoutMs, outDir }) {
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
  const saved = { TMUX: process.env.TMUX, TMUX_TMPDIR: process.env.TMUX_TMPDIR };
  delete process.env.TMUX;
  process.env.TMUX_TMPDIR = scratch;
  const session = 'background-wait-proof';
  const report = {
    runner,
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
      runnerAdapter.buildInteractiveLaunchCommand(repo, '.agent', PROMPT),
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
        }
        if (report.active && probe.kind === 'idle' && probe.stuck && probe.wouldNudge) {
          report.settled = {
            ...probe,
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
  return {
    report,
    runner,
    scenario: SCENARIO_ID,
    pass: report.pass,
    outPath: writeEvidence(report, SCENARIO_ID, runner, outDir),
  };
}
