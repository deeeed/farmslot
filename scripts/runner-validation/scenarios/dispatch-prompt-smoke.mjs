import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_PROMPT, PROMPT_MARKER } from '../lib/common.mjs';
import { runnerPromptDigest } from '../lib/digest.mjs';
import { writeEvidence } from '../lib/evidence.mjs';
import { runGatewayPostLaunchPrompt, runGatewayTurnState } from '../lib/gateway-post-launch.mjs';
import { hookDigestTurnEvidence, readHookLines } from '../lib/hooks.mjs';
import { installHooks, obsDirFor } from '../lib/install.mjs';
import { capturePane, ensureShellSession, killSession, sendShellScript } from '../lib/tmux.mjs';
import { pollHookRows } from '../lib/wait.mjs';

export const SCENARIO_ID = 'dispatch-prompt-smoke';

export async function runScenario({ runnerAdapter, timeoutMs, keepSession, outDir, model }) {
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
  const taskDir = 'temp/tasks/feat/tat-3216-round5-terra-1028-144606';
  const taskFile = `${taskDir}/TASK.md`;
  const token = randomUUID();
  const fileBacked = runner === 'codex';
  const message = fileBacked
    ? `Read ${taskFile} first.\n${'Follow the task file exactly; do not inspect unrelated files.\n'.repeat(100)}Do not modify any other file. End the turn after writing the requested result.`
    : DEFAULT_PROMPT;
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
    if (fileBacked) {
      fs.mkdirSync(path.join(repo, taskDir), { recursive: true });
      fs.writeFileSync(
        path.join(repo, taskFile),
        `Write exactly ${token} to dispatch-proof.txt in the repository root. Then end this turn. Do not run other commands.\n`,
      );
    }
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
    sendShellScript(paneId, repo, [
      runnerAdapter.buildInteractiveLaunchCommand(repo, '.agent', model ?? undefined),
    ]);

    const gatewayResult = runGatewayPostLaunchPrompt({
      repo,
      target: paneId,
      runner,
      message,
      marker: fileBacked ? 'DISPATCH-PROMPT.md' : PROMPT_MARKER,
      timeoutMs: Math.min(timeoutMs, 120_000),
      artifactsDir,
      requirePromptDigest: eventDriven,
      ...(fileBacked ? { taskDir } : {}),
    });
    report.blockerSnapshotPath = gatewayResult.blockerSnapshotPath ?? null;
    report.promptDelivered = Boolean(gatewayResult.ok);
    if (!gatewayResult.ok) {
      throw new Error(gatewayResult.error || 'sendRunnerPostLaunchPrompt failed');
    }
    if (fileBacked) {
      report.deliveredPrompt = gatewayResult.deliveredPrompt;
      report.promptFileMatches =
        fs.readFileSync(path.join(repo, taskDir, 'DISPATCH-PROMPT.md'), 'utf8') === message;
      if (
        !report.promptFileMatches ||
        gatewayResult.deliveredPrompt !==
          `Read "${taskDir}/DISPATCH-PROMPT.md" and follow its instructions.`
      ) {
        throw new Error(
          'The staged prompt or exact delivered pointer differs from the dispatch input',
        );
      }
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
      if (fileBacked) {
        report.nativeTurn = hookDigestTurnEvidence(
          hookRows,
          runnerPromptDigest(gatewayResult.deliveredPrompt),
        );
        report.responseCompleted = Boolean(report.nativeTurn);
      }
      pane = capturePane(paneId, 80);
    } else if (runnerAdapter.OBSERVABILITY_SCOPE === 'pane-only') {
      // sendRunnerPostLaunchPrompt already verified delivery. Pane-only Cursor
      // has no launch-ack signal, which is the production review miss.
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
    if (fileBacked) {
      report.taskResultMatches =
        fs.existsSync(path.join(repo, 'dispatch-proof.txt')) &&
        fs.readFileSync(path.join(repo, 'dispatch-proof.txt'), 'utf8').trim() === token;
    }
    report.pass =
      report.promptDelivered &&
      report.responseCompleted &&
      (!fileBacked || report.taskResultMatches);
  } catch (error) {
    report.error = error?.message || String(error);
    report.paneTail = paneId ? capturePane(paneId, 80) : report.paneTail;
  } finally {
    if (!keepSession) killSession(session);
  }

  const outPath = writeEvidence(report, SCENARIO_ID, runner, outDir);
  return { scenario: SCENARIO_ID, runner, outPath, pass: report.pass, report };
}
