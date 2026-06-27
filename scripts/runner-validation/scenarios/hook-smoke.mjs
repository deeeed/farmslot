import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_PROMPT, PROMPT_MARKER, sleepMs } from '../lib/common.mjs';
import { writeEvidence } from '../lib/evidence.mjs';
import {
  assertRequiredHookEvents,
  observedEvents,
  readHookLines,
  tmuxPaneSeen,
} from '../lib/hooks.mjs';
import { installHooks, obsDirFor, readRegisteredEvents } from '../lib/install.mjs';
import { runLaunchInTmux } from '../lib/launch.mjs';
import { capturePane, ensureShellSession, killSession } from '../lib/tmux.mjs';
import { waitForRunnerCompletion } from '../lib/wait.mjs';

export const SCENARIO_ID = 'hook-smoke';

export async function runScenario({ runnerAdapter, timeoutMs, keepSession, outDir }) {
  const runner = runnerAdapter.RUNNER_ID;
  const skip = runnerAdapter.skipReason?.(SCENARIO_ID);
  if (skip) {
    const report = { runner, skipped: true, skipReason: skip, pass: true };
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
    launchMode: runnerAdapter.launchMode(),
    registeredExpected: runnerAdapter.REGISTERED_EVENTS,
    registeredInstalled: null,
    observedEvents: [],
    newRows: [],
    tmuxPaneSeen: false,
    requiredEventsSeen: {},
    unknownEvents: [],
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
    report.registeredInstalled = readRegisteredEvents(runner, repo);

    runLaunchInTmux(paneId, repo, runner, runnerAdapter, DEFAULT_PROMPT);

    const completion = waitForRunnerCompletion({ paneId, logPath, beforeCount, timeoutMs });
    report.paneTail = completion.pane.split('\n').slice(-20).join('\n');

    sleepMs(5000);

    const newRows = readHookLines(logPath).slice(beforeCount);
    report.newRows = newRows;
    report.observedEvents = observedEvents(newRows);
    report.tmuxPaneSeen = tmuxPaneSeen(newRows);
    report.requiredEventsSeen = {
      SessionStart: report.observedEvents.includes('SessionStart'),
      UserPromptSubmit: report.observedEvents.includes('UserPromptSubmit'),
      Stop: report.observedEvents.includes('Stop'),
    };
    report.unknownEvents = report.observedEvents.filter(
      (name) => !runnerAdapter.REGISTERED_EVENTS.includes(name),
    );

    const registeredMatch =
      JSON.stringify(report.registeredInstalled) ===
      JSON.stringify([...runnerAdapter.REGISTERED_EVENTS].sort());
    const required = assertRequiredHookEvents(newRows, ['SessionStart', 'UserPromptSubmit', 'Stop']);

    report.pass =
      registeredMatch &&
      report.tmuxPaneSeen &&
      required.pass &&
      report.unknownEvents.length === 0 &&
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