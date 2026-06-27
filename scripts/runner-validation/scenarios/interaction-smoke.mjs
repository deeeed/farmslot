import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_PROMPT, PROMPT_MARKER, sleepMs } from '../lib/common.mjs';
import { writeEvidence } from '../lib/evidence.mjs';
import { capturePane, ensureShellSession, killSession, sendShellScript } from '../lib/tmux.mjs';
import { resolveLaunchBlockers, sendTmuxLine } from '../lib/tmux-input.mjs';

export const SCENARIO_ID = 'interaction-smoke';

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
      skipReason: 'interaction-smoke is grok production-parity only today',
      pass: true,
    };
    const outPath = writeEvidence(report, SCENARIO_ID, runner, outDir);
    return { scenario: SCENARIO_ID, runner, outPath, pass: true, skipped: true, report };
  }

  const repo = fs.mkdtempSync(path.join(os.tmpdir(), `runner-validate-${runner}-`));
  const session = `runner-validate-${runner}-${SCENARIO_ID}-${process.pid}`;
  let paneId = null;
  const report = {
    runner,
    repo,
    session,
    launchMode: runnerAdapter.interactiveLaunchMode(),
    projectDirectoryResolved: false,
    promptSubmitted: false,
    markerSeen: false,
    pass: false,
    error: null,
    paneTail: null,
  };

  try {
    runnerAdapter.prepareRepo(repo);
    const shell = ensureShellSession(session, repo);
    paneId = shell.paneId;
    sendShellScript(paneId, repo, [runnerAdapter.buildInteractiveLaunchCommand()]);

    const blockerWait = resolveLaunchBlockers(paneId, runner, Math.min(timeoutMs, 90000));
    report.projectDirectoryResolved = Boolean(blockerWait.projectSelected);
    if (!blockerWait.resolved) {
      throw new Error(
        blockerWait.blocker
          ? `launch blocker: ${blockerWait.blocker.kind}`
          : 'timed out waiting for grok composer',
      );
    }

    sleepMs(2000);
    sendTmuxLine(paneId, DEFAULT_PROMPT);
    report.promptSubmitted = true;

    const deadline = Date.now() + timeoutMs;
    let pane = capturePane(paneId, 80);
    while (Date.now() < deadline) {
      pane = capturePane(paneId, 80);
      if (pane.includes(PROMPT_MARKER)) break;
      sleepMs(2000);
    }
    report.paneTail = pane.split('\n').slice(-25).join('\n');
    report.markerSeen = pane.includes(PROMPT_MARKER);
    report.pass = report.promptSubmitted && report.markerSeen;
  } catch (error) {
    report.error = error?.message || String(error);
    report.paneTail = paneId ? capturePane(paneId, 80) : report.paneTail;
  } finally {
    if (!keepSession) killSession(session);
  }

  const outPath = writeEvidence(report, SCENARIO_ID, runner, outDir);
  return { scenario: SCENARIO_ID, runner, outPath, pass: report.pass, report };
}