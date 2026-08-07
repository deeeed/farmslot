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

function waitForIdleTurn(statePath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      const event = state.hook_event_name ?? state.event;
      if (event === 'Stop') return state;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    sleepMs(100);
  }
  throw new Error('runner did not expose an idle structured turn');
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
    baselineContract: 'an unaccepted fix prompt receives no structured-turn lease',
    currentContract:
      'an accepted fix prompt receives a liveness-guarded structured runner turn lease',
    result: null,
    liveSnapshotProbe: null,
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

    const statePath = path.join(
      obsDirFor(repo, '.agent'),
      'panes',
      `${encodeURIComponent(paneId)}.json`,
    );
    runLaunchInTmux(
      paneId,
      repo,
      runner,
      runnerAdapter,
      'Reply with exactly READY, then wait for another instruction.',
    );
    waitForIdleTurn(statePath, 60_000);

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
    report.activeHook = report.result.activeTurnObserved ? 'production-delivery' : null;

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
    const liveResultPath = path.join(repo, 'live-result.json');
    execFileSync('yarn', ['exec', 'tsx', executor], {
      cwd: root,
      env: {
        ...process.env,
        FARMSLOT_VALIDATION_REPO: repo,
        FARMSLOT_VALIDATION_TARGET: deadPaneId,
        FARMSLOT_VALIDATION_RUNNER: runner,
        FARMSLOT_VALIDATION_RESULT_PATH: liveResultPath,
        FARMSLOT_VALIDATION_PROBE_ONLY: '1',
      },
      stdio: 'pipe',
      timeout: 30_000,
    });
    report.liveSnapshotProbe = JSON.parse(fs.readFileSync(liveResultPath, 'utf-8'));
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
        FARMSLOT_VALIDATION_EXPECTED_TURN_TOKEN: report.liveSnapshotProbe.expectedTurnToken,
      },
      stdio: 'pipe',
      timeout: 30_000,
    });
    report.staleSnapshotProbe = JSON.parse(fs.readFileSync(deadResultPath, 'utf-8'));
    report.pass =
      report.result.baselineTimedOut === true &&
      report.result.unacceptedTurnLeaseRejected === true &&
      report.result.leasedSignalStatus === 'complete' &&
      report.result.activeTurnObserved === true &&
      report.result.supersedingTurnProbe.originalLeaseActive === false &&
      report.result.supersedingTurnProbe.supersedingLeaseActive === true &&
      report.result.supersedingTurnProbe.tokensDiffer === true &&
      report.liveSnapshotProbe.leaseAllowed === true &&
      report.staleSnapshotProbe.leaseAllowed === false &&
      report.staleSnapshotProbe.expectedTurnToken === report.liveSnapshotProbe.expectedTurnToken &&
      report.staleSnapshotProbe.turnReadings.some((reading) => reading.active === false);
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
