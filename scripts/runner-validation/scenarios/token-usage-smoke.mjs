import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_PROMPT, sleepMs } from '../lib/common.mjs';
import { writeEvidence } from '../lib/evidence.mjs';
import { readHookLines } from '../lib/hooks.mjs';
import { installHooks, obsDirFor } from '../lib/install.mjs';
import { runLaunchInTmux } from '../lib/launch.mjs';
import {
  ATTRIBUTION_MODELS,
  listSessionCandidates,
  modelsMatch,
  waitForSessionBinding,
} from '../lib/session-attribution.mjs';
import {
  makeUsagePoolHarness,
  pollSessionUsageFromScript,
  usageExtractedOk,
} from '../lib/session-usage-harness.mjs';
import { capturePane, ensureShellSession, killSession } from '../lib/tmux.mjs';
import { waitForRunnerCompletion } from '../lib/wait.mjs';

export const SCENARIO_ID = 'token-usage-smoke';

export async function runScenario({ runnerAdapter, timeoutMs, keepSession, outDir }) {
  const runner = runnerAdapter.RUNNER_ID;
  const skip = runnerAdapter.skipReason?.(SCENARIO_ID);
  if (skip) {
    const report = { runner, skipped: true, skipReason: skip, pass: true };
    const outPath = writeEvidence(report, SCENARIO_ID, runner, outDir);
    return { scenario: SCENARIO_ID, runner, outPath, pass: true, skipped: true, report };
  }

  const host = os.hostname().replace(/\.local$/, '');
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), `runner-validate-${runner}-usage-`));
  const runtimeDir = '.agent';
  const slotId = `runner-validate-${host}-${runner}`;
  const session = `runner-validate-${runner}-${SCENARIO_ID}-${process.pid}`;
  const logPath = path.join(obsDirFor(repo, runtimeDir), 'hooks.jsonl');
  const dispatchedModel = ATTRIBUTION_MODELS[runner] ?? null;

  let paneId = null;
  let poolHarness = null;
  const report = {
    runner,
    repo,
    slotId,
    session,
    dispatchedModel,
    resolvedPath: null,
    usage: null,
    usageStdout: null,
    modelMatch: false,
    pass: false,
    error: null,
    paneTail: null,
  };

  try {
    runnerAdapter.prepareRepo(repo);
    if (runnerAdapter.OBSERVABILITY_TRANSPORT === 'hooks') {
      installHooks(runner, repo, runtimeDir, slotId);
    }

    const beforePaths = listSessionCandidates(runner, repo, runtimeDir);
    const shell = ensureShellSession(session, repo);
    paneId = shell.paneId;

    const dispatchMs = Date.now();
    const beforeCount = readHookLines(logPath).length;

    runLaunchInTmux(paneId, repo, runner, runnerAdapter, DEFAULT_PROMPT, {
      model: dispatchedModel,
    });

    const binding = waitForSessionBinding(
      { runner, repo, beforePaths, sinceMs: dispatchMs, paneId, slotId },
      Math.min(timeoutMs, 30_000),
    );

    const completion = waitForRunnerCompletion({
      paneId,
      logPath,
      beforeCount,
      timeoutMs,
    });
    report.paneTail = completion.pane.split('\n').slice(-20).join('\n');
    sleepMs(3000);

    if (!binding) {
      throw new Error('no session path for token extraction');
    }
    report.resolvedPath = binding.runnerSessionPath;

    poolHarness = makeUsagePoolHarness(repo);
    const polled = pollSessionUsageFromScript(
      runner,
      binding.runnerSessionPath,
      poolHarness.poolDir,
    );
    report.usage = polled.usage;
    report.usageStdout = polled.stdout;
    report.modelMatch = modelsMatch(dispatchedModel, report.usage?.model ?? null);

    const fieldsPresent =
      report.usage?.input_tokens != null &&
      report.usage?.output_tokens != null &&
      report.usage?.total_tokens != null;

    report.pass =
      usageExtractedOk(report.usage) &&
      fieldsPresent &&
      report.modelMatch &&
      (completion.sawMarker || completion.sawStop);
  } catch (error) {
    report.error = error?.message || String(error);
    report.paneTail = paneId ? capturePane(paneId, 80) : report.paneTail;
  } finally {
    if (poolHarness?.root) {
      fs.rmSync(poolHarness.root, { recursive: true, force: true });
    }
    if (!keepSession) killSession(session);
  }

  const outPath = writeEvidence(report, SCENARIO_ID, runner, outDir);
  return { scenario: SCENARIO_ID, runner, outPath, pass: report.pass, report };
}
