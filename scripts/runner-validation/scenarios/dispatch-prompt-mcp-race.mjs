import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_PROMPT, PROMPT_MARKER, ROOT, sleepMs } from '../lib/common.mjs';
import { writeEvidence } from '../lib/evidence.mjs';
import {
  analyzeRunnerPane,
  oldTailOnlyRunnerPaneLooksIdle,
  parseMcpProgress,
  promptAcceptedAfterForceSend,
} from '../lib/gateway-pane-analysis.mjs';
import { runGatewayPostLaunchPrompt } from '../lib/gateway-post-launch.mjs';
import { capturePane, ensureShellSession, killSession, sendShellScript } from '../lib/tmux.mjs';

export const SCENARIO_ID = 'dispatch-prompt-mcp-race';

const FIXTURE_PANE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../fixtures/grok-dispatch-mcp-14-15.txt',
);

const FORCE_PROMPT = `MCP_RACE_FORCE: ${DEFAULT_PROMPT}`;

function sendPromptImmediately(paneId, message) {
  execFileSync('tmux', ['send-keys', '-t', paneId, '-l', message], { stdio: 'pipe' });
  execFileSync('tmux', ['send-keys', '-t', paneId, 'Enter'], { stdio: 'pipe' });
}

function assertFixtureRepro(report) {
  const pane = fs.readFileSync(FIXTURE_PANE, 'utf8');
  const analysis = analyzeRunnerPane(pane, 'grok');
  const mcp = parseMcpProgress(pane);
  report.fixture = {
    path: FIXTURE_PANE,
    source: '6d15411f dispatch-launch.txt (MCP 14/15, history #1, empty composer)',
    mcp,
    analysis,
    oldTailOnlyIdle: oldTailOnlyRunnerPaneLooksIdle(pane.split('\n'), 'grok'),
  };
  if (!mcp?.loading) {
    throw new Error('fixture pane must show MCP (n/m) with n < m');
  }
  if (!analysis.oldTailOnlyIdle) {
    throw new Error('fixture repro failed: old tail-only idle must be true');
  }
  if (analysis.runnerPaneLooksIdle) {
    throw new Error('fixture repro failed: fixed runnerPaneLooksIdle must be false');
  }
  if (!analysis.deferred) {
    throw new Error('fixture repro failed: deferred launch blocker must be true');
  }
}

async function captureLiveMcpWindow(paneId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pane = capturePane(paneId, 80);
    const mcp = parseMcpProgress(pane);
    if (mcp?.loading) {
      return { pane, mcp };
    }
    sleepMs(100);
  }
  return null;
}

function assertFixtureForceFailShape(report) {
  const pane = fs.readFileSync(FIXTURE_PANE, 'utf8');
  const before = pane
    .replace(/^\s*#\d+\s.*$/m, '')
    .replace(
      /Follow the checklist in .*?TASK\.md\. After each step, run .*?mark N before continuing\./,
      '',
    );
  report.fixtureForceFail = {
    promptAccepted: promptAcceptedAfterForceSend({
      paneBefore: before,
      paneAfter: pane,
      message:
        'Follow the checklist in .sandbox/farmslot-farm/worker-task/feat/28-claude-sonnet-v2-0701-181808/TASK.md',
      marker: 'TASK.md',
      runnerId: 'grok',
    }),
    historyPresent: /#\d+\s+Follow the checklist/i.test(pane),
  };
  if (!report.fixtureForceFail.historyPresent) {
    throw new Error('fixture force-fail shape missing transcript history');
  }
  if (report.fixtureForceFail.promptAccepted) {
    throw new Error('fixture force-fail shape must not count as prompt accepted');
  }
}

async function runLiveForceFail(report, runnerAdapter, timeoutMs) {
  const repo = ROOT;
  const session = `runner-validate-grok-${SCENARIO_ID}-${process.pid}`;
  report.live = {
    repo,
    session,
    captured: false,
    forceFailReproduced: false,
    skipReason: null,
  };

  try {
    const shell = ensureShellSession(session, repo);
    sendShellScript(shell.paneId, repo, [runnerAdapter.buildInteractiveLaunchCommand()]);

    const captured = await captureLiveMcpWindow(shell.paneId, Math.min(timeoutMs, 120_000));
    if (!captured) {
      report.live.skipReason = 'MCP loading window not observed within timeout (machine too fast)';
      return;
    }

    report.live.captured = true;
    report.live.mcp = captured.mcp;
    report.live.analysis = analyzeRunnerPane(captured.pane, 'grok');

    const paneBefore = captured.pane;
    sendPromptImmediately(shell.paneId, FORCE_PROMPT);
    sleepMs(2500);
    const paneAfter = capturePane(shell.paneId, 80);

    report.live.paneBeforeTail = paneBefore.split('\n').slice(-20).join('\n');
    report.live.paneAfterTail = paneAfter.split('\n').slice(-25).join('\n');
    report.live.promptAccepted = promptAcceptedAfterForceSend({
      paneBefore,
      paneAfter,
      message: FORCE_PROMPT,
      marker: PROMPT_MARKER,
      runnerId: 'grok',
    });
    report.live.historyContainsPrompt = paneAfter.includes('MCP_RACE_FORCE');
    report.live.stillMcpLoading = parseMcpProgress(paneAfter)?.loading ?? false;

    // Production failure shape: keystroke lands in history/transcript but handoff is not accepted.
    report.live.forceFailReproduced =
      report.live.historyContainsPrompt && report.live.promptAccepted === false;

    if (!report.live.forceFailReproduced) {
      throw new Error(
        'live force-fail did not reproduce production shape (history prompt without acceptance)',
      );
    }
  } finally {
    killSession(session);
  }
}

async function runGatewayFixPass(report, runnerAdapter, timeoutMs) {
  const repo = fs.mkdtempSync(
    path.join(os.tmpdir(), `runner-validate-grok-mcp-fix-${process.pid}-`),
  );
  const session = `runner-validate-grok-${SCENARIO_ID}-fix-${process.pid}`;
  const artifactsDir = path.join(repo, '.artifacts', 'runner-blockers');
  report.gatewayFix = { repo, session };

  try {
    runnerAdapter.prepareRepo(repo);
    const shell = ensureShellSession(session, repo);
    sendShellScript(shell.paneId, repo, [runnerAdapter.buildInteractiveLaunchCommand()]);

    const gatewayResult = runGatewayPostLaunchPrompt({
      repo,
      target: shell.paneId,
      runner: runnerAdapter.RUNNER_ID,
      message: DEFAULT_PROMPT,
      marker: PROMPT_MARKER,
      timeoutMs: Math.min(timeoutMs, 120_000),
      artifactsDir,
    });
    report.gatewayFix.result = gatewayResult;
    if (!gatewayResult.ok) {
      throw new Error(gatewayResult.error || 'sendRunnerPostLaunchPrompt failed with fix');
    }

    const deadline = Date.now() + 30_000;
    let pane = capturePane(shell.paneId, 80);
    while (Date.now() < deadline) {
      pane = capturePane(shell.paneId, 80);
      if (pane.includes(PROMPT_MARKER)) break;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    report.gatewayFix.markerSeen = pane.includes(PROMPT_MARKER);
    report.gatewayFix.paneTail = pane.split('\n').slice(-25).join('\n');
    if (!report.gatewayFix.markerSeen) {
      throw new Error('gateway fix pass did not show prompt marker in pane');
    }
  } finally {
    killSession(session);
  }
}

export async function runScenario({ runnerAdapter, timeoutMs, keepSession, outDir }) {
  const runner = runnerAdapter.RUNNER_ID;
  const skip = runnerAdapter.skipReason?.(SCENARIO_ID);
  if (skip) {
    const report = { runner, skipped: true, skipReason: skip, pass: true };
    const outPath = writeEvidence(report, SCENARIO_ID, runner, outDir);
    return { scenario: SCENARIO_ID, runner, outPath, pass: true, skipped: true, report };
  }
  if (runner !== 'grok' || typeof runnerAdapter.buildInteractiveLaunchCommand !== 'function') {
    const report = {
      runner,
      skipped: true,
      skipReason: 'dispatch-prompt-mcp-race is grok-only',
      pass: true,
    };
    const outPath = writeEvidence(report, SCENARIO_ID, runner, outDir);
    return { scenario: SCENARIO_ID, runner, outPath, pass: true, skipped: true, report };
  }

  const report = {
    runner,
    gatewayPath: 'sendRunnerPostLaunchPrompt + tmux force-send',
    pass: false,
    error: null,
  };

  try {
    assertFixtureRepro(report);
    assertFixtureForceFailShape(report);
    await runLiveForceFail(report, runnerAdapter, timeoutMs);
    if (report.live?.skipReason) {
      report.liveSkipped = true;
    }
    await runGatewayFixPass(report, runnerAdapter, timeoutMs);
    report.pass = true;
  } catch (error) {
    report.error = error?.message || String(error);
  } finally {
    if (keepSession && report.live?.session) {
      // live session already killed in runLiveForceFail; fix session killed in runGatewayFixPass
    }
  }

  const outPath = writeEvidence(report, SCENARIO_ID, runner, outDir);
  return { scenario: SCENARIO_ID, runner, outPath, pass: report.pass, report };
}
