import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_PROMPT } from '../lib/common.mjs';
import { writeEvidence } from '../lib/evidence.mjs';
import { readHookLines } from '../lib/hooks.mjs';
import { installHooks, obsDirFor } from '../lib/install.mjs';
import { runLaunchInTmux } from '../lib/launch.mjs';
import {
  ATTRIBUTION_MODELS,
  findSessionStartBinding,
  listSessionCandidates,
  modelFromTranscript,
  modelsMatch,
  resolveSessionBinding,
  seedStaleSession,
  STALE_MODELS,
  waitForSessionBinding,
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
    stalePaneRejected: null,
    pass: false,
    error: null,
    paneTail: null,
  };

  try {
    runnerAdapter.prepareRepo(repo);

    const hookDriven = runnerAdapter.OBSERVABILITY_TRANSPORT === 'hooks';
    if (hookDriven) {
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

    // Resolve while the launched runner still owns the pane. Resolving after
    // completion would validate the long-lived shell process instead of the
    // runner process boundary used by production.
    const binding = waitForSessionBinding(
      {
        runner,
        repo,
        beforePaths,
        sinceMs: dispatchMs,
        paneId,
        slotId,
      },
      Math.min(timeoutMs, 30_000),
    );
    if (!binding) throw new Error('no live session binding resolved');

    // Negative control for the real pane-scoped contract: replace the live
    // pane snapshot briefly with an identity from a prior process generation.
    // Production must fail closed rather than borrowing the stale transcript.
    if (hookDriven && report.stalePath) {
      const paneStatePath = path.join(
        obsDirFor(repo, runtimeDir),
        'panes',
        `${encodeURIComponent(paneId)}.json`,
      );
      const livePaneState = fs.readFileSync(paneStatePath, 'utf8');
      fs.writeFileSync(
        paneStatePath,
        JSON.stringify({
          observedAt: dispatchMs - 120_000,
          session_id: 'runner-stale',
          transcript_path: report.stalePath,
          tmuxPane: paneId,
          slotId,
        }),
      );
      const staleBinding = resolveSessionBinding({
        runner,
        repo,
        beforePaths,
        sinceMs: dispatchMs,
        paneId,
        slotId,
      });
      report.stalePaneRejected = staleBinding === null;
      fs.writeFileSync(paneStatePath, livePaneState);
    }

    const completion = waitForRunnerCompletion({
      paneId,
      logPath,
      beforeCount,
      timeoutMs,
    });
    report.paneTail = completion.pane.split('\n').slice(-20).join('\n');
    const hookBinding = findSessionStartBinding(readHookLines(logPath).slice(beforeCount), {
      paneId,
      slotId,
      sinceMs: dispatchMs,
    });
    report.resolvedPath = binding.runnerSessionPath;
    report.resolvedSource = binding.source;
    report.hookTranscriptPath = hookBinding?.transcriptPath ?? null;
    report.hookTmuxPane = hookBinding?.tmuxPane ?? null;
    report.actualModel = modelFromTranscript(runner, binding.runnerSessionPath);
    report.modelMatch = modelsMatch(dispatchedModel, report.actualModel);

    if (report.stalePath) {
      const staleModel = modelFromTranscript(runner, report.stalePath) ?? STALE_MODELS[runner];
      report.staleWouldMismatch = !modelsMatch(dispatchedModel, staleModel);
    }

    const pathNotStale = report.resolvedPath !== report.stalePath;
    const hookAligned =
      !hookDriven ||
      (report.hookTranscriptPath === report.resolvedPath && report.hookTmuxPane === paneId);
    const sawCompletion = completion.sawMarker || completion.sawStop;

    report.pass =
      pathNotStale &&
      hookAligned &&
      report.modelMatch &&
      report.staleWouldMismatch &&
      (!hookDriven || report.stalePaneRejected === true) &&
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
