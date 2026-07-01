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
  modelFromTranscript,
  modelsMatch,
  resolveSessionBinding,
  seedStaleSession,
  STALE_MODELS,
} from '../lib/session-attribution.mjs';
import { capturePane, ensureShellSession, killSession } from '../lib/tmux.mjs';
import { waitForRunnerCompletion } from '../lib/wait.mjs';

export const SCENARIO_ID = 'session-attribution-smoke';

export async function runScenario({ runnerAdapter, timeoutMs, keepSession, outDir }) {
  const runner = runnerAdapter.RUNNER_ID;
  const skip = runnerAdapter.skipReason?.(SCENARIO_ID);
  if (skip) {
    const report = { runner, skipped: true, skipReason: skip, pass: true };
    const outPath = writeEvidence(report, SCENARIO_ID, runner, outDir);
    return { scenario: SCENARIO_ID, runner, outPath, pass: true, skipped: true, report };
  }

  const host = os.hostname().replace(/\.local$/, '');
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), `runner-validate-${runner}-attr-`));
  const runtimeDir = '.agent';
  const slotId = `runner-validate-${host}-${runner}`;
  const session = `runner-validate-${runner}-${SCENARIO_ID}-${process.pid}`;
  const logPath = path.join(obsDirFor(repo, runtimeDir), 'hooks.jsonl');
  const dispatchedModel = ATTRIBUTION_MODELS[runner] ?? null;

  let paneId = null;
  const report = {
    runner,
    repo,
    slotId,
    session,
    dispatchedModel,
    stalePath: null,
    resolvedPath: null,
    resolvedSource: null,
    hookTranscriptPath: null,
    hookTmuxPane: null,
    staleModel: STALE_MODELS[runner] ?? null,
    actualModel: null,
    modelMatch: false,
    staleWouldMismatch: false,
    pass: false,
    error: null,
    paneTail: null,
  };

  try {
    runnerAdapter.prepareRepo(repo);

    if (runnerAdapter.OBSERVABILITY_SCOPE === 'event-driven') {
      installHooks(runner, repo, runtimeDir, slotId);
    }

    report.stalePath = seedStaleSession(runner, repo, runtimeDir);
    const beforePaths = listSessionCandidates(runner, repo, runtimeDir);

    const shell = ensureShellSession(session, repo);
    paneId = shell.paneId;

    const dispatchMs = Date.now();
    const beforeCount = readHookLines(logPath).length;

    runLaunchInTmux(paneId, repo, runner, runnerAdapter, DEFAULT_PROMPT, {
      model: dispatchedModel,
    });

    const completion = waitForRunnerCompletion({
      paneId,
      logPath,
      beforeCount,
      timeoutMs,
    });
    report.paneTail = completion.pane.split('\n').slice(-20).join('\n');
    sleepMs(3000);

    const hookRows = readHookLines(logPath).slice(beforeCount);
    const binding = resolveSessionBinding({
      runner,
      repo,
      runtimeDir,
      beforePaths,
      sinceMs: dispatchMs,
      hookRows,
      paneId,
      slotId,
    });

    if (!binding) {
      throw new Error('no session binding resolved');
    }

    report.resolvedPath = binding.runnerSessionPath;
    report.resolvedSource = binding.source;
    report.hookTranscriptPath = binding.hookBinding?.transcriptPath ?? null;
    report.hookTmuxPane = binding.hookBinding?.tmuxPane ?? null;
    report.actualModel = modelFromTranscript(runner, binding.runnerSessionPath);
    report.modelMatch = modelsMatch(dispatchedModel, report.actualModel);

    if (report.stalePath) {
      const staleModel = modelFromTranscript(runner, report.stalePath) ?? STALE_MODELS[runner];
      report.staleWouldMismatch = !modelsMatch(dispatchedModel, staleModel);
    }

    const pathNotStale = report.resolvedPath !== report.stalePath;
    const hookAligned =
      runnerAdapter.OBSERVABILITY_SCOPE !== 'event-driven' ||
      (report.hookTranscriptPath === report.resolvedPath && report.hookTmuxPane === paneId);
    const sawCompletion = completion.sawMarker || completion.sawStop;

    report.pass =
      pathNotStale &&
      hookAligned &&
      report.modelMatch &&
      report.staleWouldMismatch &&
      sawCompletion;
  } catch (error) {
    report.error = error?.message || String(error);
    report.paneTail = paneId ? capturePane(paneId, 80) : report.paneTail;
  } finally {
    if (!keepSession) killSession(session);
  }

  const outPath = writeEvidence(report, SCENARIO_ID, runner, outDir);
  return { scenario: SCENARIO_ID, runner, outPath, pass: report.pass, report };
}
