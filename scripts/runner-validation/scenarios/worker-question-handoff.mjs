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

// Manual live proof only: a real worker blocked on its own question (QA run 3e2f400a).
const QUESTION = 'Proof question: detach the checkout to the frozen head?';
const PROMPT = `Use the AskUserQuestion tool exactly once with the question "${QUESTION}" and two options, "Detach" and "Keep". After you receive the answer, reply DONE and end your turn. Do not use any other tool.`;

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
  const session = 'worker-question-proof';
  const report = { runner, scratch, session, monitor: null, cleaned: false, pass: false };
  try {
    installHooks(runner, repo, '.agent', 'worker-question-proof');
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
    report.menu = menu.trimEnd().split('\n').slice(-20).join('\n');
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        path.join(ROOT, 'scripts/runner-validation/gateway/worker-question-monitor.mts'),
        repo,
        paneId,
        QUESTION,
      ],
      { cwd: ROOT, encoding: 'utf8', timeout: 120_000, env: process.env },
    );
    if (result.status !== 0)
      throw new Error(result.stderr || result.stdout || 'Monitor proof failed');
    report.monitor = JSON.parse(
      result.stdout
        .trim()
        .split('\n')
        .findLast((line) => line.startsWith('{')),
    );
    report.pass = report.monitor.pass === true;
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
