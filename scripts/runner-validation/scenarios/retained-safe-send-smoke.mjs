import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_PROMPT, shSingleQuote } from '../lib/common.mjs';
import * as digest from '../lib/digest.mjs';
import { writeEvidence } from '../lib/evidence.mjs';
import { runGatewaySafeInstruction } from '../lib/gateway-post-launch.mjs';
import { eventName, readHookLines } from '../lib/hooks.mjs';
import { installHooks, obsDirFor } from '../lib/install.mjs';
import { capturePane, ensureShellSession, killSession, sendShellScript } from '../lib/tmux.mjs';
import { pollHookRows } from '../lib/wait.mjs';

export const SCENARIO_ID = 'retained-safe-send-smoke';

const FOLLOWUP_PROMPT = 'Reply with exactly RETAINED_SAFE_SEND_OK and nothing else.';

function ageObservability(obsDir, paneId) {
  const staleAt = Date.now() - 180_000;
  const logPath = path.join(obsDir, 'hooks.jsonl');
  const rows = readHookLines(logPath).map((row) =>
    !row.tmuxPane || row.tmuxPane === paneId
      ? { ...row, observedAt: staleAt, timestamp: staleAt }
      : row,
  );
  fs.writeFileSync(logPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  const statusPath = path.join(obsDir, 'statusline.json');
  if (fs.existsSync(statusPath)) {
    const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
    fs.writeFileSync(
      statusPath,
      JSON.stringify({ ...status, observedAt: staleAt, timestamp: staleAt, mtime: staleAt }),
    );
  }
}

export async function runScenario({ runnerAdapter, timeoutMs, keepSession, outDir }) {
  const runner = runnerAdapter.RUNNER_ID;
  if (runner !== 'claude') {
    const report = {
      runner,
      skipped: true,
      skipReason: 'stale terminal-hook recovery is Claude hook-only behavior',
      pass: true,
    };
    const outPath = writeEvidence(report, SCENARIO_ID, runner, outDir);
    return { scenario: SCENARIO_ID, runner, outPath, pass: true, skipped: true, report };
  }

  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-validate-claude-retained-send-'));
  const runtimeDir = '.agent';
  const slotId = `runner-validate-${os.hostname().replace(/\.local$/, '')}-claude`;
  const session = `runner-validate-claude-${SCENARIO_ID}-${process.pid}`;
  const obsDir = obsDirFor(repo, runtimeDir);
  const logPath = path.join(obsDir, 'hooks.jsonl');
  let paneId = null;
  const report = {
    runner,
    repo,
    session,
    initialStopped: false,
    followupDelivered: false,
    followupAccepted: false,
    pass: false,
    error: null,
    paneTail: null,
  };

  try {
    runnerAdapter.prepareRepo(repo);
    installHooks(runner, repo, runtimeDir, slotId);
    const shell = ensureShellSession(session, repo);
    paneId = shell.paneId;
    const initialCount = readHookLines(logPath).length;
    const settingsPath = path.join(obsDir, 'claude-settings.json');
    const command = `${shSingleQuote(runnerAdapter.binaryPath())} --dangerously-skip-permissions --model opus --settings ${shSingleQuote(settingsPath)} ${shSingleQuote(DEFAULT_PROMPT)}`;
    sendShellScript(paneId, repo, [command]);

    const initialRows = pollHookRows(logPath, initialCount, ['Stop'], timeoutMs);
    report.initialStopped = initialRows.some((row) => eventName(row) === 'Stop');
    if (!report.initialStopped) throw new Error('initial Claude turn did not emit Stop');

    ageObservability(obsDir, paneId);
    const followupCount = readHookLines(logPath).length;
    const safeSend = runGatewaySafeInstruction({
      repo,
      target: paneId,
      runner,
      message: FOLLOWUP_PROMPT,
      timeoutMs: Math.min(timeoutMs, 60_000),
    });
    report.followupDelivered = safeSend.result?.delivered === true;
    if (!report.followupDelivered) {
      throw new Error(safeSend.error || 'production safe-send rejected stale terminal idle state');
    }

    const followupRows = pollHookRows(
      logPath,
      followupCount,
      ['UserPromptSubmit', 'Stop'],
      timeoutMs,
    );
    const expectedDigest = digest.runnerPromptDigest(FOLLOWUP_PROMPT);
    report.followupAccepted = followupRows.some(
      (row) => eventName(row) === 'UserPromptSubmit' && row.runnerPromptDigest === expectedDigest,
    );
    report.pass = report.initialStopped && report.followupDelivered && report.followupAccepted;
    report.paneTail = capturePane(paneId, 40);
  } catch (error) {
    report.error = error?.message || String(error);
    report.paneTail = paneId ? capturePane(paneId, 80) : null;
  } finally {
    if (!keepSession) killSession(session);
  }

  const outPath = writeEvidence(report, SCENARIO_ID, runner, outDir);
  return { scenario: SCENARIO_ID, runner, outPath, pass: report.pass, report };
}
