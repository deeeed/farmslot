import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_PROMPT, PROMPT_MARKER, sleepMs } from '../lib/common.mjs';
import * as digest from '../lib/digest.mjs';
import { writeEvidence } from '../lib/evidence.mjs';
import { runGatewayPostLaunchPrompt } from '../lib/gateway-post-launch.mjs';
import { hookDigestTurnEvidence, readHookLines, writePromptSentinel } from '../lib/hooks.mjs';
import { installHooks, obsDirFor } from '../lib/install.mjs';
import {
  capturePane,
  ensureShellSession,
  killSession,
  sendShellScript,
  tmux,
} from '../lib/tmux.mjs';
import { resolveLaunchBlockers } from '../lib/tmux-input.mjs';
import { pollHookRows } from '../lib/wait.mjs';

export const SCENARIO_ID = 'dispatch-prompt-dropped-enter';

export async function runScenario({ runnerAdapter, timeoutMs, keepSession, outDir }) {
  const runner = runnerAdapter.RUNNER_ID;
  if (runner !== 'codex') {
    const report = {
      runner,
      skipped: true,
      skipReason: 'dropped-Enter recovery reproduces the Codex interactive composer path',
      pass: true,
    };
    const outPath = writeEvidence(report, SCENARIO_ID, runner, outDir);
    return { scenario: SCENARIO_ID, runner, outPath, pass: true, skipped: true, report };
  }

  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-validate-codex-dropped-enter-'));
  const runtimeDir = '.agent';
  const slotId = `runner-validate-${os.hostname().replace(/\.local$/, '')}-codex-dropped-enter`;
  const session = `runner-validate-codex-${SCENARIO_ID}-${process.pid}`;
  const obsDir = obsDirFor(repo, runtimeDir);
  const logPath = path.join(obsDir, 'hooks.jsonl');
  const artifactsDir = path.join(repo, '.artifacts', 'runner-blockers');
  let paneId = null;
  const report = {
    runner,
    repo,
    session,
    gatewayPath: 'sendRunnerPostLaunchPrompt',
    setupTransport: null,
    gatewayRecoveredBufferedPrompt: false,
    nativeTurn: null,
    gatewayLog: null,
    pass: false,
    error: null,
    paneTail: null,
  };

  try {
    runnerAdapter.prepareRepo(repo);
    installHooks(runner, repo, runtimeDir, slotId);
    const shell = ensureShellSession(session, repo);
    paneId = shell.paneId;
    sendShellScript(paneId, repo, [runnerAdapter.buildInteractiveLaunchCommand(repo, runtimeDir)]);
    const blockers = resolveLaunchBlockers(paneId, runner, Math.min(timeoutMs, 90_000));
    if (!blockers.resolved) throw new Error('Codex did not reach an interactive composer');

    const beforeCount = readHookLines(logPath).length;
    const sentinel = writePromptSentinel(obsDir, DEFAULT_PROMPT, digest);
    // Deterministic dropped-Enter postcondition: literal prompt bytes are in the
    // real Codex composer, while no submit key is sent by scenario setup.
    tmux(['send-keys', '-l', '-t', paneId, DEFAULT_PROMPT]);
    report.setupTransport = {
      literalTextSent: true,
      submitKeySent: false,
      promptDigest: sentinel.digest,
      sentAt: sentinel.sentAt,
    };
    sleepMs(1000);

    const gatewayResult = runGatewayPostLaunchPrompt({
      repo,
      target: paneId,
      runner,
      message: DEFAULT_PROMPT,
      marker: PROMPT_MARKER,
      timeoutMs: Math.min(timeoutMs, 120_000),
      artifactsDir,
      requirePromptDigest: true,
    });
    report.gatewayLog = gatewayResult.gatewayLog ?? null;
    if (!gatewayResult.ok) {
      throw new Error(gatewayResult.error || 'buffered prompt recovery failed');
    }
    report.gatewayRecoveredBufferedPrompt =
      report.gatewayLog?.includes('with submit-only delivery') === true;

    const rows = pollHookRows(logPath, beforeCount, ['UserPromptSubmit', 'Stop'], timeoutMs);
    report.nativeTurn = hookDigestTurnEvidence(rows, sentinel.digest);
    // Acceptance is native only. The gateway log records which transport
    // recovery branch ran, but rendered composer text never proves delivery.
    report.pass = Boolean(report.nativeTurn);
  } catch (error) {
    report.error = error?.message || String(error);
    report.paneTail = paneId ? capturePane(paneId, 80) : null;
  } finally {
    if (!keepSession) killSession(session);
  }

  const outPath = writeEvidence(report, SCENARIO_ID, runner, outDir);
  return { scenario: SCENARIO_ID, runner, outPath, pass: report.pass, report };
}
