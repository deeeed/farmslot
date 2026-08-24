import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_PROMPT, PROMPT_MARKER } from '../lib/common.mjs';
import { writeEvidence } from '../lib/evidence.mjs';
import { runGatewayPostLaunchPrompt, runGatewayTurnState } from '../lib/gateway-post-launch.mjs';
import { readHookLines } from '../lib/hooks.mjs';
import { installHooks, obsDirFor } from '../lib/install.mjs';
import { capturePane, ensureShellSession, killSession, sendShellScript } from '../lib/tmux.mjs';
import { pollHookRows } from '../lib/wait.mjs';

export const SCENARIO_ID = 'dispatch-prompt-smoke';

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
      skipReason: 'runner has no interactive gateway-parity launch adapter',
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
    responseCompleted: false,
    hookEvents: [],
    blockerSnapshotPath: null,
    pass: false,
    error: null,
    paneTail: null,
  };

  try {
    runnerAdapter.prepareRepo(repo);
    const eventDriven = runnerAdapter.OBSERVABILITY_SCOPE === 'event-driven';
    const hookDriven = runnerAdapter.OBSERVABILITY_TRANSPORT === 'hooks';
    const hookLogPath = path.join(obsDirFor(repo, '.agent'), 'hooks.jsonl');
    if (hookDriven) {
      installHooks(runner, repo, '.agent', `runner-validate-${runner}-dispatch`);
    }
    const beforeHookCount = hookDriven ? readHookLines(hookLogPath).length : 0;
    const shell = ensureShellSession(session, repo);
    paneId = shell.paneId;

    // Production parity: interactive launch only; gateway owns blocker resolution + prompt delivery.
    sendShellScript(paneId, repo, [runnerAdapter.buildInteractiveLaunchCommand(repo, '.agent')]);

    const gatewayResult = runGatewayPostLaunchPrompt({
      repo,
      target: paneId,
      runner,
      message: DEFAULT_PROMPT,
      marker: PROMPT_MARKER,
      timeoutMs: Math.min(timeoutMs, 120_000),
      artifactsDir,
      requirePromptDigest: eventDriven,
    });
    report.blockerSnapshotPath = gatewayResult.blockerSnapshotPath ?? null;
    report.promptDelivered = Boolean(gatewayResult.ok);
    if (!gatewayResult.ok) {
      throw new Error(gatewayResult.error || 'sendRunnerPostLaunchPrompt failed');
    }

    let pane = capturePane(paneId, 80);
    if (hookDriven) {
      const hookRows = pollHookRows(
        hookLogPath,
        beforeHookCount,
        ['UserPromptSubmit', 'Stop'],
        30_000,
      );
      report.hookEvents = hookRows.map((row) => row.hook_event_name || row.event).filter(Boolean);
      report.responseCompleted = report.hookEvents.includes('Stop');
      pane = capturePane(paneId, 80);
    } else if (runnerAdapter.OBSERVABILITY_SCOPE === 'pane-only') {
      // sendRunnerPostLaunchPrompt already verified delivery. Pane-only Cursor
      // has no launch-ack signal, which is the production self-review miss.
      report.responseCompleted = report.promptDelivered;
      pane = capturePane(paneId, 80);
    } else {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const state = runGatewayTurnState({ repo, target: paneId, runner });
        if (state?.value === 'idle' && state?.source === 'signal') {
          report.responseCompleted = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
      pane = capturePane(paneId, 80);
    }
    report.paneTail = pane.split('\n').slice(-25).join('\n');
    report.pass = report.promptDelivered && report.responseCompleted;
  } catch (error) {
    report.error = error?.message || String(error);
    report.paneTail = paneId ? capturePane(paneId, 80) : report.paneTail;
  } finally {
    if (!keepSession) killSession(session);
  }

  const outPath = writeEvidence(report, SCENARIO_ID, runner, outDir);
  return { scenario: SCENARIO_ID, runner, outPath, pass: report.pass, report };
}
