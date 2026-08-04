import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_PROMPT, sleepMs } from '../lib/common.mjs';
import { writeEvidence } from '../lib/evidence.mjs';
import { readHookLines } from '../lib/hooks.mjs';
import { installHooks, obsDirFor } from '../lib/install.mjs';
import { runLaunchInTmux } from '../lib/launch.mjs';
import { paneShowsBypassPermissions } from '../lib/pane-patterns.mjs';
import { capturePane, ensureShellSession, killSession } from '../lib/tmux.mjs';
import { waitForRunnerCompletion } from '../lib/wait.mjs';

export const SCENARIO_ID = 'mode-switch';

export async function runScenario({ runnerAdapter, timeoutMs, keepSession, outDir }) {
  const runner = runnerAdapter.RUNNER_ID;
  const skip = runnerAdapter.skipReason(SCENARIO_ID);
  const host = os.hostname().replace(/\.local$/, '');
  const report = {
    runner,
    skipped: Boolean(skip),
    skipReason: skip,
    bypassPermissionsSeen: false,
    permissionMode: null,
    pass: false,
    error: null,
    paneTail: null,
  };

  if (skip) {
    report.pass = true;
    const outPath = writeEvidence(report, SCENARIO_ID, runner, outDir);
    return { scenario: SCENARIO_ID, runner, outPath, pass: true, skipped: true, report };
  }

  const repo = fs.mkdtempSync(path.join(os.tmpdir(), `runner-validate-${runner}-`));
  const runtimeDir = '.agent';
  const slotId = `runner-validate-${host}-${runner}`;
  const session = `runner-validate-${runner}-${SCENARIO_ID}-${process.pid}`;
  const logPath = path.join(obsDirFor(repo, runtimeDir), 'hooks.jsonl');
  let paneId = null;

  try {
    runnerAdapter.prepareRepo(repo);
    const shell = ensureShellSession(session, repo);
    paneId = shell.paneId;

    const beforeCount = readHookLines(logPath).length;
    installHooks(runner, repo, runtimeDir, slotId);

    runLaunchInTmux(paneId, repo, runner, runnerAdapter, DEFAULT_PROMPT);

    const completion = waitForRunnerCompletion({ paneId, logPath, beforeCount, timeoutMs });
    report.paneTail = completion.pane.split('\n').slice(-20).join('\n');
    report.bypassPermissionsSeen = paneShowsBypassPermissions(completion.pane);

    sleepMs(5000);
    const newRows = readHookLines(logPath).slice(beforeCount);
    const sessionStart = newRows.find(
      (row) => (row.hook_event_name || row.event) === 'SessionStart',
    );
    report.permissionMode = sessionStart?.permission_mode ?? null;
    const launchCommand = runnerAdapter.buildLaunchCommand(repo, runtimeDir, DEFAULT_PROMPT);
    const launchUsesBypass = launchCommand.includes('dangerously-skip-permissions');
    const sawSubmit = newRows.some(
      (row) => (row.hook_event_name || row.event) === 'UserPromptSubmit',
    );
    report.pass =
      launchUsesBypass &&
      (report.permissionMode === 'bypassPermissions' ||
        report.bypassPermissionsSeen ||
        sawSubmit) &&
      (completion.sawMarker || completion.sawStop);
  } catch (error) {
    report.error = error?.message || String(error);
    report.paneTail = paneId ? capturePane(paneId, 80) : report.paneTail;
  } finally {
    if (!keepSession) killSession(session);
  }

  const outPath = writeEvidence(report, SCENARIO_ID, runner, outDir);
  return { scenario: SCENARIO_ID, runner, outPath, pass: report.pass, report };
}
