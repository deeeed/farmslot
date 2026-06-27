import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_PROMPT, PROMPT_MARKER, sleepMs } from '../lib/common.mjs';
import { writeEvidence } from '../lib/evidence.mjs';
import { readHookLines, turnBoundaryOrdered } from '../lib/hooks.mjs';
import { installHooks, obsDirFor } from '../lib/install.mjs';
import { runLaunchInTmux } from '../lib/launch.mjs';
import { capturePane, ensureShellSession, killSession } from '../lib/tmux.mjs';
import { pollHookRows, waitForRunnerCompletion } from '../lib/wait.mjs';

export const SCENARIO_ID = 'turn-boundary';

export async function runScenario({ runnerAdapter, timeoutMs, keepSession, outDir }) {
  const runner = runnerAdapter.RUNNER_ID;
  const host = os.hostname().replace(/\.local$/, '');
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), `runner-validate-${runner}-`));
  const runtimeDir = '.agent';
  const slotId = `runner-validate-${host}-${runner}`;
  const session = `runner-validate-${runner}-${SCENARIO_ID}-${process.pid}`;
  const logPath = path.join(obsDirFor(repo, runtimeDir), 'hooks.jsonl');

  let paneId = null;
  const report = {
    runner,
    repo,
    slotId,
    session,
    ordering: null,
    pass: false,
    error: null,
    paneTail: null,
  };

  try {
    runnerAdapter.prepareRepo(repo);
    const shell = ensureShellSession(session, repo);
    paneId = shell.paneId;

    const beforeCount = readHookLines(logPath).length;
    installHooks(runner, repo, runtimeDir, slotId);

    runLaunchInTmux(paneId, repo, runner, runnerAdapter, DEFAULT_PROMPT);

    const completion = waitForRunnerCompletion({ paneId, logPath, beforeCount, timeoutMs });
    report.paneTail = completion.pane.split('\n').slice(-20).join('\n');
    const newRows = pollHookRows(logPath, beforeCount, ['UserPromptSubmit', 'Stop'], 90000);
    report.ordering = turnBoundaryOrdered(newRows);
    report.pass = report.ordering.pass && (completion.sawMarker || completion.sawStop || report.ordering.pass);
  } catch (error) {
    report.error = error?.message || String(error);
    report.paneTail = paneId ? capturePane(paneId, 80) : report.paneTail;
  } finally {
    if (!keepSession) killSession(session);
  }

  const outPath = writeEvidence(report, SCENARIO_ID, runner, outDir);
  return { scenario: SCENARIO_ID, runner, outPath, pass: report.pass, report };
}