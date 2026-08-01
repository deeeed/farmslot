import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_PROMPT, sleepMs } from '../lib/common.mjs';
import { writeEvidence } from '../lib/evidence.mjs';
import { runGatewayRetainedHandoff } from '../lib/gateway-post-launch.mjs';
import { readHookLines } from '../lib/hooks.mjs';
import { installHooks, obsDirFor } from '../lib/install.mjs';
import { runLaunchInTmux } from '../lib/launch.mjs';
import {
  listSessionCandidates,
  resolveSessionBinding,
  runnerSessionIdForPath,
} from '../lib/session-attribution.mjs';
import { capturePane, ensureShellSession, hasSession, killSession, tmux } from '../lib/tmux.mjs';
import { waitForRunnerCompletion } from '../lib/wait.mjs';

export const SCENARIO_ID = 'retained-handoff-smoke';

export async function runScenario({ runnerAdapter, timeoutMs, keepSession, outDir }) {
  const runner = runnerAdapter.RUNNER_ID;
  if (runner !== 'claude') {
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
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-validate-claude-retained-'));
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
    const target = tmux(['display-message', '-p', '-t', paneId, '#{session_name}:#{window_index}']);
    const dispatchMs = Date.now();
    const beforeCount = readHookLines(logPath).length;

    runLaunchInTmux(paneId, repo, runner, runnerAdapter, DEFAULT_PROMPT, { model: 'opus' });
    const initial = waitForRunnerCompletion({ paneId, logPath, beforeCount, timeoutMs });
    report.initialCompleted = initial.sawStop;
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
    if (!binding) throw new Error('initial Claude session binding was not captured');
    report.sessionPath = binding.runnerSessionPath;
    report.sessionId = binding.runnerSessionId ?? runnerSessionIdForPath(binding.runnerSessionPath);

    const handoff = runGatewayRetainedHandoff({
      repo,
      target,
      runner,
      sessionId: report.sessionId,
      sessionPath: report.sessionPath,
      prompt: DEFAULT_PROMPT,
      runnerPath: runnerAdapter.binaryPath(),
      timeoutMs: Math.min(timeoutMs, 120_000),
    });
    report.handoffDelivered = Boolean(handoff.result?.delivered);
    if (!report.handoffDelivered) {
      throw new Error(handoff.error || handoff.result?.reason || 'retained handoff failed');
    }

    // The production adapter returns delivered only after a structured hook or
    // task-signal acknowledgement from the resumed process. The runner may
    // legitimately finish the tiny validation prompt and close its tmux window
    // before this parent process captures it, so pane survival is not evidence.
    report.pass = report.initialCompleted && report.handoffDelivered;
  } catch (error) {
    report.error = error?.message || String(error);
    report.paneTail = paneId && hasSession(session) ? capturePane(session, 80) : report.paneTail;
  } finally {
    if (!keepSession) killSession(session);
  }

  const outPath = writeEvidence(report, SCENARIO_ID, runner, outDir);
  return { scenario: SCENARIO_ID, runner, outPath, pass: report.pass, report };
}
