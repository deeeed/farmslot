import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_PROMPT, PROMPT_MARKER } from '../lib/common.mjs';
import { writeEvidence } from '../lib/evidence.mjs';
import { runGatewayPostLaunchPrompt } from '../lib/gateway-post-launch.mjs';
import { capturePane, ensureShellSession, killSession, sendShellScript } from '../lib/tmux.mjs';

export const SCENARIO_ID = 'dispatch-prompt-smoke';

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
      skipReason: 'dispatch-prompt-smoke is grok gateway-parity only today',
      pass: true,
    };
    const outPath = writeEvidence(report, SCENARIO_ID, runner, outDir);
    return { scenario: SCENARIO_ID, runner, outPath, pass: true, skipped: true, report };
  }

  const repo = fs.mkdtempSync(path.join(os.tmpdir(), `runner-validate-${runner}-dispatch-`));
  const session = `runner-validate-${runner}-${SCENARIO_ID}-${process.pid}`;
  const artifactsDir = path.join(repo, '.artifacts', 'runner-blockers');
  let paneId = null;
  const report = {
    runner,
    repo,
    session,
    launchMode: runnerAdapter.interactiveLaunchMode(),
    gatewayPath: 'sendRunnerPostLaunchPrompt',
    promptDelivered: false,
    markerSeen: false,
    blockerSnapshotPath: null,
    pass: false,
    error: null,
    paneTail: null,
  };

  try {
    runnerAdapter.prepareRepo(repo);
    const shell = ensureShellSession(session, repo);
    paneId = shell.paneId;

    // Production parity: interactive launch only; gateway owns blocker resolution + prompt delivery.
    sendShellScript(paneId, repo, [runnerAdapter.buildInteractiveLaunchCommand()]);

    const gatewayResult = runGatewayPostLaunchPrompt({
      repo,
      target: paneId,
      runner,
      message: DEFAULT_PROMPT,
      marker: PROMPT_MARKER,
      timeoutMs: Math.min(timeoutMs, 120_000),
      artifactsDir,
    });
    report.blockerSnapshotPath = gatewayResult.blockerSnapshotPath ?? null;
    report.promptDelivered = Boolean(gatewayResult.ok);
    if (!gatewayResult.ok) {
      throw new Error(gatewayResult.error || 'sendRunnerPostLaunchPrompt failed');
    }

    const deadline = Date.now() + 30_000;
    let pane = capturePane(paneId, 80);
    while (Date.now() < deadline) {
      pane = capturePane(paneId, 80);
      if (pane.includes(PROMPT_MARKER)) break;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    report.paneTail = pane.split('\n').slice(-25).join('\n');
    report.markerSeen = pane.includes(PROMPT_MARKER);
    report.pass = report.promptDelivered && report.markerSeen;
  } catch (error) {
    report.error = error?.message || String(error);
    report.paneTail = paneId ? capturePane(paneId, 80) : report.paneTail;
  } finally {
    if (!keepSession) killSession(session);
  }

  const outPath = writeEvidence(report, SCENARIO_ID, runner, outDir);
  return { scenario: SCENARIO_ID, runner, outPath, pass: report.pass, report };
}
