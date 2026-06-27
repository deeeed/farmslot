import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_PROMPT, PROMPT_MARKER, sleepMs } from '../lib/common.mjs';
import { writeEvidence } from '../lib/evidence.mjs';
import { runLaunchInTmux } from '../lib/launch.mjs';
import { capturePane, ensureShellSession, killSession, paneState } from '../lib/tmux.mjs';
import { waitForRunnerCompletion } from '../lib/wait.mjs';

export const SCENARIO_ID = 'pane-smoke';

export async function runScenario({ runnerAdapter, timeoutMs, keepSession, outDir }) {
  const runner = runnerAdapter.RUNNER_ID;
  const skip = runnerAdapter.skipReason?.(SCENARIO_ID);
  if (skip) {
    const report = { runner, skipped: true, skipReason: skip, pass: true };
    const outPath = writeEvidence(report, SCENARIO_ID, runner, outDir);
    return { scenario: SCENARIO_ID, runner, outPath, pass: true, skipped: true, report };
  }
  if (runnerAdapter.OBSERVABILITY_SCOPE !== 'pane-only') {
    const report = {
      runner,
      skipped: true,
      skipReason: 'pane-smoke targets pane-only runners; use hook-smoke for event-driven',
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
    launchMode: runnerAdapter.launchMode(),
    markerSeen: false,
    promptNeedleSeen: false,
    pass: false,
    error: null,
    paneTail: null,
    paneState: null,
  };

  try {
    runnerAdapter.prepareRepo(repo);
    const shell = ensureShellSession(session, repo);
    paneId = shell.paneId;
    runLaunchInTmux(paneId, repo, runner, runnerAdapter, DEFAULT_PROMPT);
    const completion = waitForRunnerCompletion({
      paneId,
      logPath: path.join(repo, '.agent', '.observability', 'hooks.jsonl'),
      beforeCount: 0,
      timeoutMs,
    });
    report.paneTail = completion.pane.split('\n').slice(-20).join('\n');
    report.markerSeen = completion.sawMarker;
    report.promptNeedleSeen = completion.pane.includes('TMUX_HOOK_OK') || completion.pane.includes(PROMPT_MARKER.slice(0, 12));
    report.paneState = paneState(paneId);
    sleepMs(2000);
    report.pass = report.markerSeen;
  } catch (error) {
    report.error = error?.message || String(error);
    report.paneTail = paneId ? capturePane(paneId, 80) : report.paneTail;
  } finally {
    if (!keepSession) killSession(session);
  }

  const outPath = writeEvidence(report, SCENARIO_ID, runner, outDir);
  return { scenario: SCENARIO_ID, runner, outPath, pass: report.pass, report };
}