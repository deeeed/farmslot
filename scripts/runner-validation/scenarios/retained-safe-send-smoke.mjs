import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_PROMPT, PROMPT_MARKER, shSingleQuote, sleepMs } from '../lib/common.mjs';
import * as digest from '../lib/digest.mjs';
import { writeEvidence } from '../lib/evidence.mjs';
import { runGatewaySafeInstruction } from '../lib/gateway-post-launch.mjs';
import { eventName, readHookLines } from '../lib/hooks.mjs';
import { installHooks, obsDirFor } from '../lib/install.mjs';
import { listSessionCandidates, resolveSessionBinding } from '../lib/session-attribution.mjs';
import { capturePane, ensureShellSession, killSession, sendShellScript } from '../lib/tmux.mjs';
import { resolveLaunchBlockers, sendTmuxLine } from '../lib/tmux-input.mjs';
import { pollHookRows } from '../lib/wait.mjs';

export const SCENARIO_ID = 'retained-safe-send-smoke';

const FOLLOWUP_PROMPT = 'Reply with exactly RETAINED_SAFE_SEND_OK and nothing else.';

function capturePaneBestEffort(paneId, lines) {
  try {
    return capturePane(paneId, lines);
  } catch {
    return null;
  }
}

function ageObservability(obsDir, paneId) {
  const ageMs = 180_000;
  const logPath = path.join(obsDir, 'hooks.jsonl');
  const rows = readHookLines(logPath).map((row) =>
    !row.tmuxPane || row.tmuxPane === paneId
      ? {
          ...row,
          ...(typeof row.observedAt === 'number' ? { observedAt: row.observedAt - ageMs } : {}),
          ...(typeof row.timestamp === 'number' ? { timestamp: row.timestamp - ageMs } : {}),
        }
      : row,
  );
  fs.writeFileSync(logPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  const statusPath = path.join(obsDir, 'statusline.json');
  if (fs.existsSync(statusPath)) {
    const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
    fs.writeFileSync(
      statusPath,
      JSON.stringify({
        ...status,
        ...(typeof status.observedAt === 'number' ? { observedAt: status.observedAt - ageMs } : {}),
        ...(typeof status.timestamp === 'number' ? { timestamp: status.timestamp - ageMs } : {}),
        ...(typeof status.mtime === 'number' ? { mtime: status.mtime - ageMs } : {}),
      }),
    );
  }
}

function waitForPaneText(paneId, text, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let pane = '';
  while (Date.now() < deadline) {
    pane = capturePane(paneId, 100);
    if (pane.includes(text)) return pane;
    sleepMs(1000);
  }
  throw new Error(`timed out waiting for ${JSON.stringify(text)} in runner pane`);
}

function waitForGrokSessionBinding({ repo, paneId, beforePaths, sinceMs, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const binding = resolveSessionBinding({
      runner: 'grok',
      repo,
      runtimeDir: '.agent',
      beforePaths,
      sinceMs,
      hookRows: [],
      paneId,
      slotId: 'runner-validate-local',
    });
    if (binding) return binding;
    sleepMs(500);
  }
  return null;
}

function runGrokScenario({ runnerAdapter, timeoutMs, keepSession, outDir }) {
  const runner = runnerAdapter.RUNNER_ID;
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-validate-grok-retained-send-'));
  const session = `runner-validate-grok-${SCENARIO_ID}-${process.pid}`;
  let paneId = null;
  const report = {
    runner,
    repo,
    session,
    initialCompleted: false,
    mismatchedSessionRejected: false,
    followupDelivered: false,
    followupAccepted: false,
    mismatchedSend: null,
    pass: false,
    error: null,
    paneTail: null,
  };

  try {
    runnerAdapter.prepareRepo(repo);
    const beforePaths = listSessionCandidates(runner, repo, '.agent');
    const shell = ensureShellSession(session, repo);
    paneId = shell.paneId;
    const dispatchMs = Date.now();
    sendShellScript(paneId, repo, [runnerAdapter.buildInteractiveLaunchCommand()]);
    const blockers = resolveLaunchBlockers(paneId, runner, Math.min(timeoutMs, 90_000));
    if (!blockers.resolved) throw new Error('Grok did not reach an interactive composer');
    sleepMs(2000);
    sendTmuxLine(paneId, DEFAULT_PROMPT);
    waitForPaneText(paneId, PROMPT_MARKER, timeoutMs);
    report.initialCompleted = true;

    const binding = waitForGrokSessionBinding({
      repo,
      paneId,
      beforePaths,
      sinceMs: dispatchMs,
      timeoutMs: Math.min(timeoutMs, 30_000),
    });
    if (!binding?.runnerSessionId || !binding.runnerSessionPath) {
      throw new Error('Grok did not expose an exact retained session binding');
    }
    sleepMs(1500);

    const mismatchedSend = runGatewaySafeInstruction({
      repo,
      target: paneId,
      runner,
      message: FOLLOWUP_PROMPT,
      sessionId: `${binding.runnerSessionId}-mismatch`,
      sessionPath: binding.runnerSessionPath,
      timeoutMs: 10_000,
    });
    report.mismatchedSend = mismatchedSend;
    report.mismatchedSessionRejected = mismatchedSend.result?.delivered === false;
    if (!report.mismatchedSessionRejected) {
      throw new Error(
        mismatchedSend.error || 'production safe-send accepted a mismatched Grok session binding',
      );
    }

    const safeSend = runGatewaySafeInstruction({
      repo,
      target: paneId,
      runner,
      message: FOLLOWUP_PROMPT,
      sessionId: binding.runnerSessionId,
      sessionPath: binding.runnerSessionPath,
      timeoutMs: Math.min(timeoutMs, 30_000),
    });
    report.followupDelivered = safeSend.result?.delivered === true;
    if (!report.followupDelivered) {
      throw new Error(safeSend.error || 'production safe-send rejected the exact Grok session');
    }
    report.paneTail = waitForPaneText(paneId, 'RETAINED_SAFE_SEND_OK', timeoutMs);
    report.followupAccepted = true;
    report.pass =
      report.initialCompleted &&
      report.mismatchedSessionRejected &&
      report.followupDelivered &&
      report.followupAccepted;
  } catch (error) {
    report.error = error?.message || String(error);
    report.paneTail = paneId ? capturePaneBestEffort(paneId, 100) : null;
  } finally {
    if (!keepSession) killSession(session);
  }

  const outPath = writeEvidence(report, SCENARIO_ID, runner, outDir);
  return { scenario: SCENARIO_ID, runner, outPath, pass: report.pass, report };
}

export async function runScenario({ runnerAdapter, timeoutMs, keepSession, outDir }) {
  const runner = runnerAdapter.RUNNER_ID;
  if (runner === 'grok') {
    return runGrokScenario({ runnerAdapter, timeoutMs, keepSession, outDir });
  }
  if (runner !== 'claude') {
    const report = {
      runner,
      skipped: true,
      skipReason: 'stale terminal-hook recovery is Claude hook-only behavior',
      pass: true,
    };
    const outPath = writeEvidence(report, SCENARIO_ID, runner, outDir);
    return { scenario: SCENARIO_ID, runner, outPath, pass: true, skipped: true, report };
  }

  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-validate-claude-retained-send-'));
  const runtimeDir = '.agent';
  const slotId = `runner-validate-${os.hostname().replace(/\.local$/, '')}-claude`;
  const session = `runner-validate-claude-${SCENARIO_ID}-${process.pid}`;
  const obsDir = obsDirFor(repo, runtimeDir);
  const logPath = path.join(obsDir, 'hooks.jsonl');
  let paneId = null;
  const report = {
    runner,
    repo,
    session,
    initialStopped: false,
    mismatchedSessionRejected: false,
    followupDelivered: false,
    followupAccepted: false,
    mismatchedSend: null,
    pass: false,
    error: null,
    paneTail: null,
  };

  try {
    runnerAdapter.prepareRepo(repo);
    installHooks(runner, repo, runtimeDir, slotId);
    const shell = ensureShellSession(session, repo);
    paneId = shell.paneId;
    const initialCount = readHookLines(logPath).length;
    const settingsPath = path.join(obsDir, 'claude-settings.json');
    const command = `${shSingleQuote(runnerAdapter.binaryPath())} --dangerously-skip-permissions --model opus --settings ${shSingleQuote(settingsPath)} ${shSingleQuote(DEFAULT_PROMPT)}`;
    sendShellScript(paneId, repo, [command]);

    const initialRows = pollHookRows(logPath, initialCount, ['Stop'], timeoutMs);
    const stopRow = [...initialRows].reverse().find((row) => eventName(row) === 'Stop');
    report.initialStopped = Boolean(stopRow);
    if (!report.initialStopped) throw new Error('initial Claude turn did not emit Stop');
    const sessionId = stopRow?.session_id;
    const sessionPath = stopRow?.transcript_path;
    if (!sessionId || !sessionPath) {
      throw new Error('terminal hook did not expose an exact retained session binding');
    }

    ageObservability(obsDir, paneId);
    const followupCount = readHookLines(logPath).length;
    const mismatchedSend = runGatewaySafeInstruction({
      repo,
      target: paneId,
      runner,
      message: FOLLOWUP_PROMPT,
      sessionId: `${sessionId}-mismatch`,
      sessionPath,
      timeoutMs: 10_000,
    });
    report.mismatchedSend = mismatchedSend;
    report.mismatchedSessionRejected = mismatchedSend.result?.delivered === false;
    if (!report.mismatchedSessionRejected) {
      throw new Error(
        mismatchedSend.error ||
          'production safe-send accepted a mismatched retained session binding',
      );
    }
    const safeSend = runGatewaySafeInstruction({
      repo,
      target: paneId,
      runner,
      message: FOLLOWUP_PROMPT,
      sessionId,
      sessionPath,
      timeoutMs: Math.min(timeoutMs, 10_000),
    });
    report.followupDelivered = safeSend.result?.delivered === true;
    if (!report.followupDelivered) {
      throw new Error(safeSend.error || 'production safe-send rejected stale terminal idle state');
    }

    const followupRows = pollHookRows(
      logPath,
      followupCount,
      ['UserPromptSubmit', 'Stop'],
      timeoutMs,
    );
    const expectedDigest = digest.runnerPromptDigest(FOLLOWUP_PROMPT);
    report.followupAccepted = followupRows.some(
      (row) => eventName(row) === 'UserPromptSubmit' && row.runnerPromptDigest === expectedDigest,
    );
    report.pass =
      report.initialStopped &&
      report.mismatchedSessionRejected &&
      report.followupDelivered &&
      report.followupAccepted;
    report.paneTail = capturePaneBestEffort(paneId, 40);
  } catch (error) {
    report.error = error?.message || String(error);
    report.paneTail = paneId ? capturePaneBestEffort(paneId, 80) : null;
  } finally {
    if (!keepSession) killSession(session);
  }

  const outPath = writeEvidence(report, SCENARIO_ID, runner, outDir);
  return { scenario: SCENARIO_ID, runner, outPath, pass: report.pass, report };
}
