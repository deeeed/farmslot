import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PROMPT_MARKER, sleepMs } from '../lib/common.mjs';
import { writeEvidence } from '../lib/evidence.mjs';
import { runGatewayPaneProcessStartedAt } from '../lib/gateway-post-launch.mjs';
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
const LIVE_ATTRIBUTION_PROMPT = `Use the shell tool to run sleep 15, then reply with exactly ${PROMPT_MARKER} and nothing else.`;

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
    staleControlSameSecond: null,
    deadPaneWithoutInventoryRejected: null,
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
    let staleControlPath = null;
    if (hookDriven && report.stalePath) {
      staleControlPath = path.join(repo, runtimeDir, 'stale-process-boundary.jsonl');
      fs.copyFileSync(report.stalePath, staleControlPath);
    }

    const shell = ensureShellSession(session, repo);
    paneId = shell.paneId;

    const dispatchMs = Date.now();
    const beforeCount = readHookLines(logPath).length;

    runLaunchInTmux(paneId, repo, runner, runnerAdapter, LIVE_ATTRIBUTION_PROMPT, {
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
    let paneStatePath = null;
    let livePaneState = null;
    if (hookDriven && report.stalePath && staleControlPath) {
      const paneProcessStartedAtMs = runGatewayPaneProcessStartedAt({
        repo,
        target: paneId,
        runner,
      });
      if (typeof paneProcessStartedAtMs !== 'number') {
        throw new Error('live runner process boundary was unavailable');
      }
      const staleObservedAt = paneProcessStartedAtMs - 1;
      report.staleControlSameSecond =
        Math.floor(staleObservedAt / 1_000) === Math.floor(paneProcessStartedAtMs / 1_000);
      if (!report.staleControlSameSecond) {
        throw new Error('runner process began on a wall-clock second boundary; retry scenario');
      }
      paneStatePath = path.join(
        obsDirFor(repo, runtimeDir),
        'panes',
        `${encodeURIComponent(paneId)}.json`,
      );
      livePaneState = fs.readFileSync(paneStatePath, 'utf8');
      fs.writeFileSync(
        paneStatePath,
        JSON.stringify({
          // Deliberately remain in the same wall-clock second as launch. The
          // control passes dispatch freshness and can only be rejected by the
          // precise runner-process generation boundary.
          observedAt: staleObservedAt,
          session_id: 'runner-stale',
          transcript_path: staleControlPath,
          tmuxPane: paneId,
          slotId,
        }),
      );
      const staleBinding = resolveSessionBinding({
        runner,
        repo,
        beforePaths: [report.stalePath],
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
      requireStop: hookDriven,
    });
    if (paneStatePath && livePaneState && report.stalePath) {
      const runnerExitDeadline = Date.now() + 15_000;
      while (
        runGatewayPaneProcessStartedAt({ repo, target: paneId, runner }) !== null &&
        Date.now() < runnerExitDeadline
      ) {
        sleepMs(100);
      }
      if (runGatewayPaneProcessStartedAt({ repo, target: paneId, runner }) !== null) {
        throw new Error('runner process remained live after structured completion');
      }
      fs.writeFileSync(
        paneStatePath,
        JSON.stringify({
          observedAt: Date.now(),
          session_id: 'runner-stale-dead-pane',
          transcript_path: report.stalePath,
          tmuxPane: paneId,
          slotId,
        }),
      );
      const deadPaneBinding = resolveSessionBinding({
        runner,
        repo,
        beforePaths: [],
        sinceMs: dispatchMs,
        paneId,
        slotId,
      });
      report.deadPaneWithoutInventoryRejected = deadPaneBinding === null;
      fs.writeFileSync(paneStatePath, livePaneState);
    }
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
    const sawCompletion = hookDriven
      ? completion.sawStop
      : completion.sawMarker || completion.sawStop;

    report.pass =
      pathNotStale &&
      hookAligned &&
      report.modelMatch &&
      report.staleWouldMismatch &&
      (!hookDriven || report.stalePaneRejected === true) &&
      (!hookDriven || report.staleControlSameSecond === true) &&
      (!hookDriven || report.deadPaneWithoutInventoryRejected === true) &&
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
