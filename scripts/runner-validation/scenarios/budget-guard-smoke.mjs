import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_PROMPT, sleepMs } from '../lib/common.mjs';
import { writeEvidence } from '../lib/evidence.mjs';
import { runGatewayBudgetGuard, runGatewayWarmBudgetCharge } from '../lib/gateway-post-launch.mjs';
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
  let harnessRoot = null;
  const report = {
    runner,
    repo,
    slotId,
    session,
    initialCompleted: false,
    sessionBinding: null,
    guard: null,
    nudgeAccepted: false,
    childTurnCompleted: false,
    warmCharge: null,
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
      // Phase two re-polls the same warm run after a real turn lands.
      keepHarness: true,
    });
    harnessRoot = report.guard.harnessRoot ?? null;
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

    // Phase two — the claim "the child is charged only for what it appends" cannot fail
    // while nothing has been appended: the charge is total minus baseline with both
    // sides equal. Drive one real turn on the live runner, then re-poll.
    if (!harnessRoot || !result.warmRunId) {
      throw new Error('budget guard did not expose a warm run to re-poll');
    }
    const beforeChildTurn = readHookLines(logPath).length;
    sendTmuxLine(paneId, DEFAULT_PROMPT);
    const childRows = pollHookRows(logPath, beforeChildTurn, ['Stop'], timeoutMs);
    report.childTurnCompleted = childRows.some((row) => eventName(row) === 'Stop');
    if (!report.childTurnCompleted) throw new Error('post-pin Codex turn did not emit Stop');
    sleepMs(1500);

    report.warmCharge = runGatewayWarmBudgetCharge({
      harnessRoot,
      runId: result.warmRunId,
      slotId,
      timeoutMs: Math.min(timeoutMs, 90_000),
    });
    if (report.warmCharge.exitCode !== 0 || !report.warmCharge.result) {
      throw new Error(report.warmCharge.error || 'warm budget charge returned no result');
    }
    const charge = report.warmCharge.result;
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
      // A confirmed delivery spends exactly one of the capped attempts.
      result.persistedAfterFirst?.budgetNudgeAttempts === 1 &&
      result.persistedAfterSecond?.budgetNudgeAttempts === 1 &&
      result.unsupportedWarmBaseline === 'not-required' &&
      // Warm handoff pins accounting at the transcript's EOF: the child inherits no
      // counted usage, so even ceilings of 1 do not breach on parent history.
      result.warmBaseline?.status === 'captured' &&
      result.warmBaseline?.pinnedAtRecordBoundary === true &&
      result.warmBaseline?.baselineTurns === 0 &&
      // Codex restates session totals on every record, so the baseline must carry the
      // parent's real cumulative total. A zero here is the false-breach bug.
      result.warmBaseline?.baselineTotalTokens > 0 &&
      result.warmBaseline?.baselineTotalTokens === result.first?.sampleTotalTokens &&
      result.warmBaseline?.breachedOnInheritedHistory === false &&
      // The discriminating check: after a real post-pin turn the child is charged only
      // its own growth. With a zeroed cumulative baseline this equals the whole session
      // total instead, which is the false breach.
      charge.chargeTotalTokens > 0 &&
      charge.baselineTotalTokens > 0 &&
      charge.chargeTotalTokens === charge.sampleTotalTokens - charge.baselineTotalTokens &&
      // The parent's history is excluded. With a zeroed cumulative baseline the charge
      // would equal the full session total instead — the false breach.
      charge.chargeTotalTokens < charge.sampleTotalTokens &&
      charge.budgetWarned === false &&
      // An unmeasurable runner is recorded for the operator, never typed at the worker.
      result.unmeasuredRunner?.unsupportedRunner === true &&
      result.unmeasuredRunner?.violationType === 'budget' &&
      /enforcement unsupported/.test(result.unmeasuredRunner?.violationMessage ?? '') &&
      result.unmeasuredRunner?.nudgeSent === false &&
      result.unmeasuredRunner?.budgetNudgeAttempts === 0 &&
      result.violationEvents === 2 &&
      report.nudgeAccepted;
  } catch (error) {
    report.error = error?.message || String(error);
    report.paneTail = paneId ? capturePane(paneId, 100) : null;
  } finally {
    if (!keepSession) killSession(session);
    if (harnessRoot) fs.rmSync(harnessRoot, { recursive: true, force: true });
  }

  const outPath = writeEvidence(report, SCENARIO_ID, runner, outDir);
  return { scenario: SCENARIO_ID, runner, outPath, pass: report.pass, report };
}
