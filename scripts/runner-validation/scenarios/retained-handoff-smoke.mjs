import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_PROMPT, sleepMs } from '../lib/common.mjs';
import { writeEvidence } from '../lib/evidence.mjs';
import { runGatewayRepeatReviewResume } from '../lib/gateway-post-launch.mjs';
import { eventName, readHookLines } from '../lib/hooks.mjs';
import { installHooks, obsDirFor } from '../lib/install.mjs';
import { runLaunchInTmux } from '../lib/launch.mjs';
import {
  listSessionCandidates,
  resolveSessionBinding,
  runnerSessionIdForPath,
} from '../lib/session-attribution.mjs';
import { capturePane, ensureShellSession, hasSession, killSession, tmux } from '../lib/tmux.mjs';
import { pollHookRows } from '../lib/wait.mjs';

export const SCENARIO_ID = 'retained-handoff-smoke';

export async function runScenario({ runnerAdapter, timeoutMs, keepSession, outDir }) {
  const runner = runnerAdapter.RUNNER_ID;
  if (runner !== 'claude' && runner !== 'codex') {
    const report = {
      runner,
      skipped: true,
      skipReason: 'runner does not declare retained resume-with-prompt',
      pass: true,
    };
    const outPath = writeEvidence(report, SCENARIO_ID, runner, outDir);
    return { scenario: SCENARIO_ID, runner, outPath, pass: true, skipped: true, report };
  }

  const host = os.hostname().replace(/\.local$/, '');
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), `runner-validate-${runner}-retained-`));
  const runtimeDir = '.agent';
  const slotId = `runner-validate-${host}-${runner}`;
  const session = `runner-validate-${runner}-${SCENARIO_ID}-${process.pid}`;
  const logPath = path.join(obsDirFor(repo, runtimeDir), 'hooks.jsonl');
  let paneId = null;
  const report = {
    runner,
    repo,
    session,
    sessionId: null,
    sessionPath: null,
    initialCompleted: false,
    handoffDelivered: false,
    repeatReviewSessionTrace: null,
    repeatReviewResumePlan: null,
    repeatReviewResetPlan: null,
    repeatReviewSlotMismatchPlan: null,
    repeatReviewUnavailablePlan: null,
    paneReplacedBeforeResume: false,
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
    let target = tmux(['display-message', '-p', '-t', paneId, '#{session_name}:#{window_index}']);
    const dispatchMs = Date.now();
    const beforeCount = readHookLines(logPath).length;

    const model = runner === 'claude' ? 'opus' : undefined;
    runLaunchInTmux(paneId, repo, runner, runnerAdapter, DEFAULT_PROMPT, { model });
    const initialRows = pollHookRows(logPath, beforeCount, ['Stop'], timeoutMs);
    report.initialCompleted = initialRows.some((row) => eventName(row) === 'Stop');
    sleepMs(2000);

    const binding = resolveSessionBinding({
      runner,
      repo,
      runtimeDir,
      beforePaths,
      sinceMs: dispatchMs,
      hookRows: readHookLines(logPath).slice(beforeCount),
      paneId,
      slotId,
    });
    if (!binding) throw new Error(`initial ${runner} session binding was not captured`);
    report.sessionPath = binding.runnerSessionPath;
    report.sessionId =
      binding.runnerSessionId ?? runnerSessionIdForPath(runner, binding.runnerSessionPath);
    if (!report.sessionId) throw new Error(`initial ${runner} session id was not captured`);

    const repeatReviewReset = runGatewayRepeatReviewResume({
      repo,
      target,
      runner,
      sessionId: report.sessionId,
      sessionPath: report.sessionPath,
      prompt: DEFAULT_PROMPT,
      runnerPath: runnerAdapter.binaryPath(),
      model,
      slotId,
      sessionIntent: 'reset',
      expectedKind: 'not-resumed',
    });
    report.repeatReviewResetPlan = repeatReviewReset.result?.plan ?? null;
    if (repeatReviewReset.result?.plan?.kind !== 'reset') {
      throw new Error(repeatReviewReset.error || 'repeat-review policy did not honor reset');
    }
    const repeatReviewSlotMismatch = runGatewayRepeatReviewResume({
      repo,
      target,
      runner,
      sessionId: report.sessionId,
      sessionPath: report.sessionPath,
      prompt: DEFAULT_PROMPT,
      runnerPath: runnerAdapter.binaryPath(),
      model,
      slotId,
      currentSlotId: `${slotId}-other`,
      expectedKind: 'not-resumed',
    });
    report.repeatReviewSlotMismatchPlan = repeatReviewSlotMismatch.result?.plan ?? null;
    if (
      repeatReviewSlotMismatch.result?.plan?.kind !== 'fallback' ||
      repeatReviewSlotMismatch.result?.plan?.reason !== 'slot-mismatch'
    ) {
      throw new Error(
        repeatReviewSlotMismatch.error || 'repeat-review policy did not reject another slot',
      );
    }
    const repeatReviewUnavailable = runGatewayRepeatReviewResume({
      repo,
      target,
      runner,
      sessionId: report.sessionId,
      sessionPath: `${report.sessionPath}.missing`,
      prompt: DEFAULT_PROMPT,
      runnerPath: runnerAdapter.binaryPath(),
      model,
      slotId,
      expectedKind: 'fallback',
    });
    report.repeatReviewUnavailablePlan = repeatReviewUnavailable.result?.plan ?? null;
    if (repeatReviewUnavailable.result?.plan?.reason !== 'session-unavailable') {
      throw new Error(
        repeatReviewUnavailable.error || 'repeat-review policy did not safely fall back',
      );
    }

    const priorPaneId = paneId;
    killSession(session);
    const replacement = ensureShellSession(session, repo);
    paneId = replacement.paneId;
    target = tmux(['display-message', '-p', '-t', paneId, '#{session_name}:#{window_index}']);
    report.paneReplacedBeforeResume = paneId !== priorPaneId;
    if (!report.paneReplacedBeforeResume) {
      throw new Error('retained handoff did not replace the owning pane');
    }

    const handoff = runGatewayRepeatReviewResume({
      repo,
      target,
      runner,
      sessionId: report.sessionId,
      sessionPath: report.sessionPath,
      prompt: DEFAULT_PROMPT,
      runnerPath: runnerAdapter.binaryPath(),
      model,
      slotId,
      timeoutMs: Math.min(timeoutMs, 120_000),
    });
    report.repeatReviewResumePlan = handoff.result?.plan ?? null;
    report.repeatReviewSessionTrace = handoff.result?.trace ?? null;
    report.handoffDelivered = handoff.result?.kind === 'resumed';
    if (!report.handoffDelivered) {
      throw new Error(handoff.error || handoff.result?.reason || 'retained handoff failed');
    }

    // The production adapter returns delivered only after a structured hook or
    // task-signal acknowledgement from the resumed process. The runner may
    // legitimately finish the tiny validation prompt and close its tmux window
    // before this parent process captures it, so pane survival is not evidence.
    report.pass =
      report.initialCompleted &&
      report.repeatReviewResumePlan?.kind === 'resume' &&
      report.repeatReviewResetPlan?.kind === 'reset' &&
      report.repeatReviewSlotMismatchPlan?.reason === 'slot-mismatch' &&
      report.repeatReviewUnavailablePlan?.reason === 'session-unavailable' &&
      report.paneReplacedBeforeResume &&
      report.handoffDelivered;
  } catch (error) {
    report.error = error?.message || String(error);
    report.paneTail = paneId && hasSession(session) ? capturePane(session, 80) : report.paneTail;
  } finally {
    if (!keepSession) killSession(session);
  }

  const outPath = writeEvidence(report, SCENARIO_ID, runner, outDir);
  return { scenario: SCENARIO_ID, runner, outPath, pass: report.pass, report };
}
