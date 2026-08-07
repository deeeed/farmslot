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

function waitForActiveTurn(statePath, timeoutMs, excludedSessionId = null) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      const event = state.hook_event_name ?? state.event;
      if (
        (event === 'UserPromptSubmit' || event === 'PreToolUse') &&
        (!excludedSessionId || state.session_id !== excludedSessionId)
      ) {
        return state;
      }
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
  const runnerBin = runnerAdapter.binaryPath();
  let paneId = null;
  const report = {
    runner,
    baselineContract: 'an unaccepted fix prompt receives no structured-turn lease',
    currentContract:
      'an accepted fix prompt receives a liveness-guarded structured runner turn lease',
    result: null,
    liveSnapshotProbe: null,
    staleSnapshotProbe: null,
    restartBoundaryProbe: null,
    reoccupiedPaneProbe: null,
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
        FARMSLOT_VALIDATION_RUNNER_BIN: runnerBin,
        FARMSLOT_VALIDATION_RESULT_PATH: resultPath,
      },
      stdio: 'pipe',
      timeout: 180_000,
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
        FARMSLOT_VALIDATION_RUNNER_BIN: runnerBin,
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
        FARMSLOT_VALIDATION_RUNNER_BIN: runnerBin,
        FARMSLOT_VALIDATION_RESULT_PATH: deadResultPath,
        FARMSLOT_VALIDATION_PROBE_ONLY: '1',
        FARMSLOT_VALIDATION_EXPECTED_TURN_TOKEN: report.liveSnapshotProbe.expectedTurnToken,
      },
      stdio: 'pipe',
      timeout: 30_000,
    });
    report.staleSnapshotProbe = JSON.parse(fs.readFileSync(deadResultPath, 'utf-8'));
    if (runner === 'claude') {
      const obsDir = obsDirFor(repo, '.agent');
      execFileSync(
        process.execPath,
        [path.join(obsDir, 'bin', 'farmslot-observability-hook.mjs')],
        {
          cwd: repo,
          env: {
            ...process.env,
            FARMSLOT_OBS_DIR: obsDir,
            FARMSLOT_SLOT_ID: 'runner-validation-self-review-fix-turn-lease',
            FARMSLOT_RUNNER: runner,
            TMUX_PANE: deadPaneId,
          },
          input: JSON.stringify({
            hook_event_name: 'SessionStart',
            source: 'resume',
            session_id: activeState.session_id,
            transcript_path: activeState.transcript_path,
            cwd: repo,
          }),
        },
      );
      const restartResultPath = path.join(repo, 'restart-result.json');
      execFileSync('yarn', ['exec', 'tsx', executor], {
        cwd: root,
        env: {
          ...process.env,
          FARMSLOT_VALIDATION_REPO: repo,
          FARMSLOT_VALIDATION_TARGET: deadPaneId,
          FARMSLOT_VALIDATION_RUNNER: runner,
          FARMSLOT_VALIDATION_RUNNER_BIN: runnerBin,
          FARMSLOT_VALIDATION_RESULT_PATH: restartResultPath,
          FARMSLOT_VALIDATION_PROBE_ONLY: '1',
          FARMSLOT_VALIDATION_EXPECTED_TURN_TOKEN: report.liveSnapshotProbe.expectedTurnToken,
        },
        stdio: 'pipe',
        timeout: 30_000,
      });
      report.restartBoundaryProbe = JSON.parse(fs.readFileSync(restartResultPath, 'utf-8'));
    }
    runLaunchInTmux(
      deadPaneId,
      repo,
      runner,
      runnerAdapter,
      'Use the shell tool exactly once to run this command, and do nothing else: sleep 60',
    );
    waitForActiveTurn(deadStatePath, 60_000, activeState.session_id);
    const reoccupiedResultPath = path.join(repo, 'reoccupied-result.json');
    execFileSync('yarn', ['exec', 'tsx', executor], {
      cwd: root,
      env: {
        ...process.env,
        FARMSLOT_VALIDATION_REPO: repo,
        FARMSLOT_VALIDATION_TARGET: deadPaneId,
        FARMSLOT_VALIDATION_RUNNER: runner,
        FARMSLOT_VALIDATION_RUNNER_BIN: runnerBin,
        FARMSLOT_VALIDATION_RESULT_PATH: reoccupiedResultPath,
        FARMSLOT_VALIDATION_PROBE_ONLY: '1',
        FARMSLOT_VALIDATION_EXPECTED_TURN_TOKEN: report.liveSnapshotProbe.expectedTurnToken,
      },
      stdio: 'pipe',
      timeout: 30_000,
    });
    report.reoccupiedPaneProbe = JSON.parse(fs.readFileSync(reoccupiedResultPath, 'utf-8'));
    report.pass =
      report.result.baselineTimedOut === true &&
      report.result.unacceptedTurnLeaseRejected === true &&
      report.result.busyLeaseActiveBeforeFix === true &&
      report.result.fixTurnSeparatedFromBusyTurn === true &&
      (runner !== 'claude' ||
        (report.result.lifecycleLeaseProbe?.preCompact === true &&
          report.result.lifecycleLeaseProbe?.compactSessionStart === true &&
          report.result.lifecycleLeaseProbe?.postCompact === true)) &&
      report.result.leasedSignalStatus === 'complete' &&
      report.result.activeTurnObserved === true &&
      report.result.supersedingTurnProbe.originalLeaseActive === false &&
      report.result.supersedingTurnProbe.supersedingLeaseActive === true &&
      report.result.supersedingTurnProbe.tokensDiffer === true &&
      report.liveSnapshotProbe.leaseAllowed === true &&
      report.staleSnapshotProbe.leaseAllowed === false &&
      report.staleSnapshotProbe.expectedTurnToken === report.liveSnapshotProbe.expectedTurnToken &&
      report.staleSnapshotProbe.turnReadings.some((reading) => reading.active === false) &&
      (runner !== 'claude' ||
        (report.restartBoundaryProbe.leaseAllowed === false &&
          report.restartBoundaryProbe.turnReadings.some(
            (reading) => reading.stateValue === 'idle' && reading.actualTurnToken === null,
          ))) &&
      report.reoccupiedPaneProbe.leaseAllowed === false &&
      report.reoccupiedPaneProbe.expectedTurnToken === report.liveSnapshotProbe.expectedTurnToken &&
      report.reoccupiedPaneProbe.turnReadings.some(
        (reading) => reading.runnerAlive === true && reading.active === false,
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
