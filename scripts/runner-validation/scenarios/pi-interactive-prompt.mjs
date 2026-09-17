import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_PROMPT, sleepMs } from '../lib/common.mjs';
import * as digest from '../lib/digest.mjs';
import { writeEvidence } from '../lib/evidence.mjs';
import { eventName, readHookLines, writePromptSentinel } from '../lib/hooks.mjs';
import { installHooks, obsDirFor } from '../lib/install.mjs';
import { capturePane, ensureShellSession, killSession, sendShellScript } from '../lib/tmux.mjs';
import { sendTmuxLine } from '../lib/tmux-input.mjs';
import { pollHookRows } from '../lib/wait.mjs';

export const SCENARIO_ID = 'pi-interactive-prompt';

export async function runScenario({ runnerAdapter, timeoutMs, keepSession, outDir }) {
  const runner = runnerAdapter.RUNNER_ID;
  const skip = runnerAdapter.skipReason?.(SCENARIO_ID);
  if (skip) {
    const report = { runner, skipped: true, skipReason: skip, pass: true };
    const outPath = writeEvidence(report, SCENARIO_ID, runner, outDir);
    return { scenario: SCENARIO_ID, runner, outPath, pass: true, skipped: true, report };
  }
  if (typeof runnerAdapter.buildInteractiveLaunchCommand !== 'function') {
    const report = {
      runner,
      skipped: true,
      skipReason: 'no interactive launch command',
      pass: true,
    };
    const outPath = writeEvidence(report, SCENARIO_ID, runner, outDir);
    return { scenario: SCENARIO_ID, runner, outPath, pass: true, skipped: true, report };
  }

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
    launchMode: runnerAdapter.interactiveLaunchMode?.() ?? 'interactive',
    digest: null,
    hookDigest: null,
    sessionStarted: false,
    promptSubmitted: false,
    turnStopped: false,
    pass: false,
    error: null,
    paneTail: null,
  };

  try {
    runnerAdapter.prepareRepo(repo);
    const shell = ensureShellSession(session, repo);
    paneId = shell.paneId;

    installHooks(runner, repo, runtimeDir, slotId);
    const { digest: expectedDigest } = writePromptSentinel(
      obsDirFor(repo, runtimeDir),
      DEFAULT_PROMPT,
      digest,
    );
    report.digest = expectedDigest;

    const beforeCount = readHookLines(logPath).length;
    sendShellScript(paneId, repo, [runnerAdapter.buildInteractiveLaunchCommand(repo, runtimeDir)]);

    const startRows = pollHookRows(
      logPath,
      beforeCount,
      ['SessionStart'],
      Math.min(timeoutMs, 60000),
    );
    report.sessionStarted = startRows.some((row) => eventName(row) === 'SessionStart');
    if (!report.sessionStarted) {
      throw new Error('timed out waiting for SessionStart hook from interactive PI TUI');
    }

    sleepMs(2500);
    sendTmuxLine(paneId, DEFAULT_PROMPT);

    const afterRows = pollHookRows(
      logPath,
      beforeCount,
      ['UserPromptSubmit', 'Stop'],
      Math.min(timeoutMs, 120000),
    );
    const submit = afterRows.find(
      (row) => eventName(row) === 'UserPromptSubmit' && row.runnerPromptDigest === expectedDigest,
    );
    report.hookDigest = submit?.runnerPromptDigest ?? null;
    report.promptSubmitted = Boolean(submit);
    report.turnStopped = afterRows.some((row) => eventName(row) === 'Stop');
    report.paneTail = capturePane(paneId, 40);
    report.pass = report.sessionStarted && report.promptSubmitted && report.turnStopped;
    if (!report.pass) {
      throw new Error(
        `interactive hooks incomplete: start=${report.sessionStarted} submit=${report.promptSubmitted} stop=${report.turnStopped}`,
      );
    }
  } catch (error) {
    report.error = error?.message || String(error);
    report.paneTail = paneId ? capturePane(paneId, 80) : report.paneTail;
  } finally {
    if (!keepSession) killSession(session);
  }

  const outPath = writeEvidence(report, SCENARIO_ID, runner, outDir);
  return { scenario: SCENARIO_ID, runner, outPath, pass: report.pass, report };
}
