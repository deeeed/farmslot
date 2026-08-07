import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { sleepMs } from '../lib/common.mjs';
import { writeEvidence } from '../lib/evidence.mjs';
import { installHooks, obsDirFor } from '../lib/install.mjs';
import { runLaunchInTmux } from '../lib/launch.mjs';
import { capturePane, ensureShellSession, killSession } from '../lib/tmux.mjs';

export const SCENARIO_ID = 'self-review-fix-turn-lease';

function waitForActiveTurn(statePath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      const event = state.hook_event_name ?? state.event;
      if (event === 'UserPromptSubmit' || event === 'PreToolUse') return state;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    sleepMs(100);
  }
  throw new Error('runner did not expose an active structured turn');
}

export async function runScenario({ runnerAdapter, keepSession, outDir }) {
  const runner = runnerAdapter.RUNNER_ID;
  if (runnerAdapter.OBSERVABILITY_SCOPE !== 'event-driven') {
    const report = {
      runner,
      skipped: true,
      skipReason: 'structured turn lease requires hooks',
      pass: true,
    };
    const outPath = writeEvidence(report, SCENARIO_ID, runner, outDir);
    return { scenario: SCENARIO_ID, runner, outPath, pass: true, skipped: true, report };
  }

  const root = process.cwd();
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), `runner-validate-${runner}-turn-lease-`));
  const taskDir = path.join(repo, 'task');
  const resultPath = path.join(repo, 'result.json');
  const session = `runner-validate-${runner}-${SCENARIO_ID}-${process.pid}`;
  const deadSession = `${session}-dead`;
  let paneId = null;
  const report = {
    runner,
    baselineContract: 'signal-file progress only',
    currentContract: 'signal-file progress plus liveness-guarded structured runner turn state',
    result: null,
    staleSnapshotProbe: null,
    activeHook: null,
    paneTail: null,
    pass: false,
    error: null,
  };

  try {
    runnerAdapter.prepareRepo(repo);
    fs.mkdirSync(taskDir, { recursive: true });
    const shell = ensureShellSession(session, repo);
    paneId = shell.paneId;
    installHooks(runner, repo, '.agent', 'runner-validation-self-review-fix-turn-lease');

    const signal = JSON.stringify({
      role: 'self-review',
      status: 'complete',
      outcome: 'success',
      disposition: 'fixed',
      timestamp: new Date().toISOString(),
    });
    const command = `sleep 14; printf '%s\\n' '${signal}' > task/SELF-REVIEW-FIX-SIGNAL.json`;
    const prompt = `Use the shell tool exactly once to run this command, and do nothing else: ${command}`;
    runLaunchInTmux(paneId, repo, runner, runnerAdapter, prompt);

    const statePath = path.join(
      obsDirFor(repo, '.agent'),
      'panes',
      `${encodeURIComponent(paneId)}.json`,
    );
    report.activeHook = waitForActiveTurn(statePath, 60_000).hook_event_name;

    const executor = path.join(
      root,
      'scripts/runner-validation/gateway/self-review-fix-turn-lease.mts',
    );
    execFileSync('yarn', ['exec', 'tsx', executor], {
      cwd: root,
      env: {
        ...process.env,
        FARMSLOT_VALIDATION_REPO: repo,
        FARMSLOT_VALIDATION_TARGET: paneId,
        FARMSLOT_VALIDATION_RUNNER: runner,
        FARMSLOT_VALIDATION_RESULT_PATH: resultPath,
      },
      stdio: 'pipe',
      timeout: 90_000,
    });
    report.result = JSON.parse(fs.readFileSync(resultPath, 'utf-8'));

    const deadShell = ensureShellSession(deadSession, repo);
    const deadPaneId = deadShell.paneId;
    const deadPrompt =
      'Use the shell tool exactly once to run this command, and do nothing else: sleep 60';
    runLaunchInTmux(deadPaneId, repo, runner, runnerAdapter, deadPrompt);
    const deadStatePath = path.join(
      obsDirFor(repo, '.agent'),
      'panes',
      `${encodeURIComponent(deadPaneId)}.json`,
    );
    const activeState = waitForActiveTurn(deadStatePath, 60_000);
    execFileSync('tmux', ['respawn-pane', '-k', '-t', deadPaneId, '-c', repo]);
    fs.writeFileSync(deadStatePath, `${JSON.stringify(activeState)}\n`, 'utf-8');
    const deadResultPath = path.join(repo, 'dead-result.json');
    execFileSync('yarn', ['exec', 'tsx', executor], {
      cwd: root,
      env: {
        ...process.env,
        FARMSLOT_VALIDATION_REPO: repo,
        FARMSLOT_VALIDATION_TARGET: deadPaneId,
        FARMSLOT_VALIDATION_RUNNER: runner,
        FARMSLOT_VALIDATION_RESULT_PATH: deadResultPath,
        FARMSLOT_VALIDATION_PROBE_ONLY: '1',
      },
      stdio: 'pipe',
      timeout: 30_000,
    });
    report.staleSnapshotProbe = JSON.parse(fs.readFileSync(deadResultPath, 'utf-8'));
    report.pass =
      report.result.baselineTimedOut === true &&
      report.result.leasedSignalStatus === 'complete' &&
      report.result.activeTurnObserved === true &&
      report.result.turnReadings.some((reading) => reading.runnerAlive === true) &&
      report.staleSnapshotProbe.leaseAllowed === false &&
      report.staleSnapshotProbe.turnReadings.some(
        (reading) => reading.value === 'active' && reading.runnerAlive === false,
      );
  } catch (error) {
    report.error = error?.message || String(error);
  } finally {
    report.paneTail = paneId ? capturePane(paneId, 60) : null;
    if (!keepSession) {
      killSession(session);
      killSession(deadSession);
      fs.rmSync(repo, { recursive: true, force: true });
    }
  }

  const outPath = writeEvidence(report, SCENARIO_ID, runner, outDir);
  return { scenario: SCENARIO_ID, runner, outPath, pass: report.pass, report };
}
