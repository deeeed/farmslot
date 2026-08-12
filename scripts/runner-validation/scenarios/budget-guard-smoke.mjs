import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_PROMPT, sleepMs } from '../lib/common.mjs';
import { writeEvidence } from '../lib/evidence.mjs';
import { runGatewayBudgetGuard } from '../lib/gateway-post-launch.mjs';
import { eventName, readHookLines } from '../lib/hooks.mjs';
import { installHooks, obsDirFor } from '../lib/install.mjs';
import { listSessionCandidates, waitForSessionBinding } from '../lib/session-attribution.mjs';
import { capturePane, ensureShellSession, killSession, sendShellScript } from '../lib/tmux.mjs';
import { resolveLaunchBlockers, sendTmuxLine } from '../lib/tmux-input.mjs';
import { pollHookRows } from '../lib/wait.mjs';

export const SCENARIO_ID = 'budget-guard-smoke';

export async function runScenario({ runnerAdapter, timeoutMs, keepSession, outDir }) {
  const runner = runnerAdapter.RUNNER_ID;
  if (runner !== 'codex') {
    const report = {
      runner,
      skipped: true,
      skipReason: 'budget guard delivery proof currently requires the interactive Codex TUI',
      pass: true,
    };
    const outPath = writeEvidence(report, SCENARIO_ID, runner, outDir);
    return { scenario: SCENARIO_ID, runner, outPath, pass: true, skipped: true, report };
  }

  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-validate-codex-budget-'));
  const runtimeDir = '.agent';
  const slotId = `runner-validate-${os.hostname().replace(/\.local$/, '')}-codex-budget`;
  const session = `runner-validate-codex-${SCENARIO_ID}-${process.pid}`;
  const logPath = path.join(obsDirFor(repo, runtimeDir), 'hooks.jsonl');
  let paneId = null;
  const report = {
    runner,
    repo,
    slotId,
    session,
    initialCompleted: false,
    sessionBinding: null,
    guard: null,
    nudgeAccepted: false,
    pass: false,
    error: null,
    paneTail: null,
  };

  try {
    runnerAdapter.prepareRepo(repo);
    installHooks(runner, repo, runtimeDir, slotId);
    const beforePaths = listSessionCandidates(runner, repo, runtimeDir);
    const shell = ensureShellSession(session, repo);
    paneId = shell.paneId;
    const dispatchMs = Date.now();
    const initialCount = readHookLines(logPath).length;
    sendShellScript(paneId, repo, [runnerAdapter.buildInteractiveLaunchCommand(repo, runtimeDir)]);
    const blockers = resolveLaunchBlockers(paneId, runner, Math.min(timeoutMs, 90_000));
    if (!blockers.resolved) throw new Error('Codex did not reach an interactive composer');
    sendTmuxLine(paneId, DEFAULT_PROMPT);
    const binding = waitForSessionBinding(
      { runner, repo, beforePaths, sinceMs: dispatchMs, paneId, slotId },
      Math.min(timeoutMs, 30_000),
    );
    const initialRows = pollHookRows(logPath, initialCount, ['Stop'], timeoutMs);
    report.initialCompleted = initialRows.some((row) => eventName(row) === 'Stop');
    if (!report.initialCompleted) throw new Error('initial Codex turn did not emit Stop');

    if (!binding?.runnerSessionId || !binding.runnerSessionPath) {
      throw new Error('Codex did not expose an exact session binding');
    }
    report.sessionBinding = binding;
    sleepMs(1500);

    const beforeBudgetNudge = readHookLines(logPath).length;
    report.guard = runGatewayBudgetGuard({
      repo,
      slotId,
      session,
      target: paneId,
      runner,
      sessionId: binding.runnerSessionId,
      sessionPath: binding.runnerSessionPath,
      timeoutMs: Math.min(timeoutMs, 90_000),
    });
    if (report.guard.exitCode !== 0 || !report.guard.result) {
      throw new Error(report.guard.error || 'production budget tick returned no result');
    }

    const nudgeRows = pollHookRows(
      logPath,
      beforeBudgetNudge,
      ['UserPromptSubmit'],
      Math.min(timeoutMs, 60_000),
    );
    report.nudgeAccepted = nudgeRows.some((row) => eventName(row) === 'UserPromptSubmit');
    const result = report.guard.result;
    report.pass =
      result.first?.budgetWarned === true &&
      result.first?.violationType === 'budget' &&
      result.first?.nudgeSent === true &&
      result.persistedAfterFirst?.budgetWarned === true &&
      result.persistedAfterFirst?.budgetNudgeSent === true &&
      result.second?.budgetWarned === true &&
      result.second?.violationType === null &&
      result.second?.nudgeSent === false &&
      result.persistedAfterSecond?.budgetNudgeSent === true &&
      result.unsupportedWarmBaseline === 'not-required' &&
      result.violationEvents === 1 &&
      report.nudgeAccepted;
  } catch (error) {
    report.error = error?.message || String(error);
    report.paneTail = paneId ? capturePane(paneId, 100) : null;
  } finally {
    if (!keepSession) killSession(session);
  }

  const outPath = writeEvidence(report, SCENARIO_ID, runner, outDir);
  return { scenario: SCENARIO_ID, runner, outPath, pass: report.pass, report };
}
