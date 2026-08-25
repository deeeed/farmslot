import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_PROMPT, ROOT, shSingleQuote, sleepMs } from '../lib/common.mjs';
import { writeEvidence } from '../lib/evidence.mjs';
import {
  runGatewayArgvRelaunch,
  runGatewayRepeatReviewResume,
} from '../lib/gateway-post-launch.mjs';
import { eventName, readHookLines } from '../lib/hooks.mjs';
import { installHooks, obsDirFor } from '../lib/install.mjs';
import { runLaunchInTmux } from '../lib/launch.mjs';
import {
  listSessionCandidates,
  runnerSessionIdForPath,
  waitForSessionBinding,
} from '../lib/session-attribution.mjs';
import {
  capturePane,
  ensureShellSession,
  hasSession,
  killSession,
  sendShellScript,
  tmux,
} from '../lib/tmux.mjs';
import { pollHookRows } from '../lib/wait.mjs';

export const SCENARIO_ID = 'retained-handoff-smoke';

async function runCursorArgvRelaunch({ runnerAdapter, timeoutMs, keepSession, outDir }) {
  const runner = runnerAdapter.RUNNER_ID;
  const session = `runner-validate-${runner}-${SCENARIO_ID}-${process.pid}`;
  fs.mkdirSync(path.join(ROOT, 'temp'), { recursive: true });
  const tempRoot = fs.mkdtempSync(path.join(ROOT, 'temp', 'cursor-argv-relaunch-'));
  const replacementReadySignalPath = path.join(tempRoot, 'PRIOR-TASK-SIGNAL.json');
  const signalPath = path.join(tempRoot, 'SELF-REVIEW-SIGNAL.json');
  const attemptId = `cursor-argv-relaunch-${process.pid}`;
  const report = {
    runner,
    session,
    target: null,
    initialSignal: null,
    priorPanePid: null,
    replacementPanePid: null,
    acknowledgement: null,
    signal: null,
    paneTail: null,
    pass: false,
    error: null,
  };

  try {
    fs.writeFileSync(
      signalPath,
      `${JSON.stringify({
        attemptId: 'baseline',
        status: 'complete',
        step: 'old-turn',
        timestamp: new Date(0).toISOString(),
      })}\n`,
    );
    const shell = ensureShellSession(session, ROOT);
    report.target = shell.paneId;
    const initialSignal = JSON.stringify({
      attemptId: `cursor-retained-initial-${process.pid}`,
      status: 'complete',
      step: 'initial-turn-complete',
      timestamp: new Date().toISOString(),
    });
    const initialWriteScript = `require('node:fs').writeFileSync(${JSON.stringify(replacementReadySignalPath)}, ${JSON.stringify(`${initialSignal}\n`)})`;
    const initialWriteScriptPath = path.join(tempRoot, 'write-prior-task-signal.cjs');
    fs.writeFileSync(initialWriteScriptPath, `${initialWriteScript}\n`);
    const initialPrompt =
      `Run this exact command now, then remain available for follow-up work: ` +
      `node ${shSingleQuote(initialWriteScriptPath)}`;
    sendShellScript(shell.paneId, ROOT, [runnerAdapter.buildBusyLaunchCommand(initialPrompt)]);
    const initialDeadline = Date.now() + timeoutMs;
    while (!fs.existsSync(replacementReadySignalPath) && Date.now() < initialDeadline) sleepMs(500);
    if (!fs.existsSync(replacementReadySignalPath)) {
      throw new Error('Initial retained Cursor turn did not write its terminal task signal');
    }
    report.initialSignal = JSON.parse(fs.readFileSync(replacementReadySignalPath, 'utf8'));
    report.priorPanePid = tmux(['display-message', '-p', '-t', shell.paneId, '#{pane_pid}']);
    const nextSignal = JSON.stringify({
      attemptId,
      status: 'running',
      step: 'argv-relaunch-accepted',
      timestamp: new Date().toISOString(),
    });
    const writeSignalScript = `require('node:fs').writeFileSync(${JSON.stringify(signalPath)}, ${JSON.stringify(`${nextSignal}\n`)})`;
    const writeSignalScriptPath = path.join(tempRoot, 'write-next-task-signal.cjs');
    fs.writeFileSync(writeSignalScriptPath, `${writeSignalScript}\n`);
    const prompt =
      `Run this exact command now, then report completion: ` +
      `node ${shSingleQuote(writeSignalScriptPath)}`;
    const handoff = runGatewayArgvRelaunch({
      repo: ROOT,
      target: shell.paneId,
      runner,
      runnerPath: runnerAdapter.binaryPath(),
      model: 'cursor-grok-4.6-high-fast',
      prompt,
      replacementReadySignalPath,
      signalPath,
      timeoutMs,
    });
    report.acknowledgement = handoff.result?.acknowledgement ?? null;
    report.signal = JSON.parse(fs.readFileSync(signalPath, 'utf8'));
    report.replacementPanePid = hasSession(session)
      ? tmux(['display-message', '-p', '-t', session, '#{pane_pid}'])
      : null;
    report.paneTail = hasSession(session) ? capturePane(session, 80) : null;
    report.pass =
      handoff.exitCode === 0 &&
      handoff.result?.delivered === true &&
      handoff.result?.acknowledgement === 'structured' &&
      report.initialSignal.status === 'complete' &&
      report.priorPanePid !== report.replacementPanePid &&
      report.signal.attemptId === attemptId &&
      report.signal.status === 'running';
    if (!report.pass) {
      throw new Error(
        handoff.stderr || handoff.stdout || 'Cursor argv relaunch did not produce structured proof',
      );
    }
  } catch (error) {
    report.error = error?.message || String(error);
  } finally {
    if (!keepSession) killSession(session);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  const outPath = writeEvidence(report, SCENARIO_ID, runner, outDir);
  return { scenario: SCENARIO_ID, runner, outPath, pass: report.pass, report };
}

function resolveLiveResetPlan(runner) {
  const snippet = `
import { retainedReviewerDeliveryPlan } from './services/gateway/src/runners/registry.ts';
console.log(JSON.stringify(retainedReviewerDeliveryPlan(${JSON.stringify(runner)}, 'reset', 1)));
`;
  const stdout = execFileSync('yarn', ['exec', 'tsx', '-e', snippet], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  return JSON.parse(stdout.trim().split('\n').at(-1));
}

export async function runScenario({ runnerAdapter, timeoutMs, keepSession, outDir }) {
  const runner = runnerAdapter.RUNNER_ID;
  if (runner === 'cursor') {
    return runCursorArgvRelaunch({ runnerAdapter, timeoutMs, keepSession, outDir });
  }
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
    liveReviewerResetPlan: null,
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
    report.liveReviewerResetPlan = resolveLiveResetPlan(runner);
    runLaunchInTmux(paneId, repo, runner, runnerAdapter, DEFAULT_PROMPT, { model });
    const binding = waitForSessionBinding(
      { runner, repo, beforePaths, sinceMs: dispatchMs, paneId, slotId },
      Math.min(timeoutMs, 30_000),
    );
    const initialRows = pollHookRows(logPath, beforeCount, ['Stop'], timeoutMs);
    report.initialCompleted = initialRows.some((row) => eventName(row) === 'Stop');
    sleepMs(2000);

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
      report.liveReviewerResetPlan?.kind === (runner === 'claude' ? 'in-place' : 'cold-relaunch') &&
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
