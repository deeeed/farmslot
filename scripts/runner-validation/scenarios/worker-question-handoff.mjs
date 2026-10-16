import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { ROOT } from '../lib/common.mjs';
import { writeEvidence } from '../lib/evidence.mjs';
import { installHooks } from '../lib/install.mjs';
import {
  ensureShellSession,
  killSession,
  sendShellScript,
  waitForPaneMatch,
} from '../lib/tmux.mjs';
import { resolveLaunchBlockers } from '../lib/tmux-input.mjs';

export const SCENARIO_ID = 'worker-question-handoff';

// Manual live proof only: a real worker blocked on its own question (QA run 3e2f400a),
// once in one monitor process and once across a monitor restart.
const QUESTION = 'Proof question: detach the checkout to the frozen head?';
const PROMPT = `Use the AskUserQuestion tool exactly once with the question "${QUESTION}" and two options, "Detach" and "Keep". After you receive the answer, reply DONE and end your turn. Do not use any other tool.`;
const HELPER = path.join(ROOT, 'scripts/runner-validation/gateway/worker-question-monitor.mts');

function monitor(args) {
  const result = spawnSync(process.execPath, ['--import', 'tsx', HELPER, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120_000,
    env: process.env,
  });
  if (result.status !== 0)
    throw new Error(result.stderr || result.stdout || 'Monitor proof failed');
  return JSON.parse(
    result.stdout
      .trim()
      .split('\n')
      .findLast((line) => line.startsWith('{')),
  );
}

function askQuestion(runnerAdapter, runner, repo, session, timeoutMs) {
  const { paneId } = ensureShellSession(session, repo);
  sendShellScript(paneId, repo, [
    runnerAdapter.buildInteractiveLaunchCommand(repo, '.agent', PROMPT),
  ]);
  resolveLaunchBlockers(paneId, runner, Math.min(timeoutMs, 30_000));
  const menu = waitForPaneMatch(
    paneId,
    (pane) => pane.includes('detach the checkout') && /enter to select/i.test(pane),
    timeoutMs,
  );
  if (!menu) throw new Error('The worker never showed its question menu');
  return { paneId, menu: menu.trimEnd().split('\n').slice(-20).join('\n') };
}

export async function runScenario({ runnerAdapter, timeoutMs, outDir }) {
  const runner = runnerAdapter.RUNNER_ID;
  if (runner !== 'claude') {
    const report = { runner, skipped: true, pass: true, skipReason: 'Requires AskUserQuestion' };
    return {
      report,
      runner,
      scenario: SCENARIO_ID,
      pass: true,
      skipped: true,
      outPath: writeEvidence(report, SCENARIO_ID, runner, outDir),
    };
  }
  const scratch = fs.mkdtempSync('/tmp/fs-worker-question-');
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
  const sessions = ['worker-question-proof', 'worker-question-restart'];
  const report = { runner, scratch, single: null, restart: null, cleaned: false, pass: false };
  try {
    installHooks(runner, repo, '.agent', 'worker-question-proof');
    const single = askQuestion(runnerAdapter, runner, repo, sessions[0], timeoutMs);
    report.menu = single.menu;
    report.single = monitor([
      repo,
      single.paneId,
      QUESTION,
      'single',
      path.join(scratch, 'control-single'),
    ]);
    killSession(sessions[0]);

    // The first monitor process exits while the handoff is pending; a new one recovers it.
    const restart = askQuestion(runnerAdapter, runner, repo, sessions[1], timeoutMs);
    const control = path.join(scratch, 'control-restart');
    const raised = monitor([repo, restart.paneId, QUESTION, 'raise', control]);
    const recovered = monitor([repo, restart.paneId, QUESTION, 'recover', control, raised.runId]);
    report.restart = { raised, recovered };
    report.pass =
      report.single.pass === true &&
      recovered.pass === true &&
      recovered.decisionId === raised.decisionId;
  } catch (error) {
    report.error = error.message;
  } finally {
    try {
      for (const session of sessions) killSession(session);
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
