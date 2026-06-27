import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_PROMPT, PROMPT_MARKER, sleepMs } from '../lib/common.mjs';
import * as digest from '../lib/digest.mjs';
import { writeEvidence } from '../lib/evidence.mjs';
import { readHookLines, writePromptSentinel } from '../lib/hooks.mjs';
import { installHooks, obsDirFor } from '../lib/install.mjs';
import { runLaunchInTmux } from '../lib/launch.mjs';
import { capturePane, ensureShellSession, killSession } from '../lib/tmux.mjs';
import { waitForRunnerCompletion } from '../lib/wait.mjs';

export const SCENARIO_ID = 'prompt-accepted';

export async function runScenario({ runnerAdapter, timeoutMs, keepSession, outDir }) {
  const runner = runnerAdapter.RUNNER_ID;
  const host = os.hostname().replace(/\.local$/, '');
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), `runner-validate-${runner}-`));
  const runtimeDir = '.agent';
  const slotId = `runner-validate-${host}-${runner}`;
  const session = `runner-validate-${runner}-${SCENARIO_ID}-${process.pid}`;
  const obsDir = obsDirFor(repo, runtimeDir);
  const logPath = path.join(obsDir, 'hooks.jsonl');

  let paneId = null;
  const report = {
    runner,
    repo,
    slotId,
    session,
    digest: null,
    hookDigest: null,
    pass: false,
    error: null,
    paneTail: null,
  };

  try {
    runnerAdapter.prepareRepo(repo);
    const shell = ensureShellSession(session, repo);
    paneId = shell.paneId;

    installHooks(runner, repo, runtimeDir, slotId);
    const { digest: expectedDigest } = writePromptSentinel(obsDir, DEFAULT_PROMPT, digest);
    report.digest = expectedDigest;

    const beforeCount = readHookLines(logPath).length;
    runLaunchInTmux(paneId, repo, runner, runnerAdapter, DEFAULT_PROMPT);

    const completion = waitForRunnerCompletion({ paneId, logPath, beforeCount, timeoutMs });
    report.paneTail = completion.pane.split('\n').slice(-20).join('\n');
    sleepMs(5000);

    const submitRow = readHookLines(logPath)
      .slice(beforeCount)
      .find((row) => (row.hook_event_name || row.event) === 'UserPromptSubmit');
    report.hookDigest = submitRow?.runnerPromptDigest ?? null;
    report.pass =
      report.hookDigest === expectedDigest && (completion.sawMarker || completion.sawStop);
  } catch (error) {
    report.error = error?.message || String(error);
    report.paneTail = paneId ? capturePane(paneId, 80) : report.paneTail;
  } finally {
    if (!keepSession) killSession(session);
  }

  const outPath = writeEvidence(report, SCENARIO_ID, runner, outDir);
  return { scenario: SCENARIO_ID, runner, outPath, pass: report.pass, report };
}