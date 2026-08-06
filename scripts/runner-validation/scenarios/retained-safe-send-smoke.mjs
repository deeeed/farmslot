import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_PROMPT, shSingleQuote, sleepMs } from '../lib/common.mjs';
import * as digest from '../lib/digest.mjs';
import { writeEvidence } from '../lib/evidence.mjs';
import { runGatewaySafeInstruction } from '../lib/gateway-post-launch.mjs';
import { eventName, hookDigestTurnEvidence, readHookLines } from '../lib/hooks.mjs';
import { installHooks, obsDirFor } from '../lib/install.mjs';
import {
  grokSessionDirKeys,
  listSessionCandidates,
  resolveSessionBinding,
} from '../lib/session-attribution.mjs';
import { capturePane, ensureShellSession, killSession, sendShellScript } from '../lib/tmux.mjs';
import { resolveLaunchBlockers, sendTmuxLine } from '../lib/tmux-input.mjs';
import { pollHookRows } from '../lib/wait.mjs';

export const SCENARIO_ID = 'retained-safe-send-smoke';

const FOLLOWUP_PROMPT = 'Reply with exactly RETAINED_SAFE_SEND_OK and nothing else.';

function capturePaneBestEffort(paneId, lines) {
  try {
    return capturePane(paneId, lines);
  } catch {
    return null;
  }
}

function ageObservability(obsDir, paneId) {
  const ageMs = 180_000;
  const logPath = path.join(obsDir, 'hooks.jsonl');
  const rows = readHookLines(logPath).map((row) =>
    !row.tmuxPane || row.tmuxPane === paneId
      ? {
          ...row,
          ...(typeof row.observedAt === 'number' ? { observedAt: row.observedAt - ageMs } : {}),
          ...(typeof row.timestamp === 'number' ? { timestamp: row.timestamp - ageMs } : {}),
        }
      : row,
  );
  fs.writeFileSync(logPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  const statusPath = path.join(obsDir, 'statusline.json');
  if (fs.existsSync(statusPath)) {
    const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
    fs.writeFileSync(
      statusPath,
      JSON.stringify({
        ...status,
        ...(typeof status.observedAt === 'number' ? { observedAt: status.observedAt - ageMs } : {}),
        ...(typeof status.timestamp === 'number' ? { timestamp: status.timestamp - ageMs } : {}),
        ...(typeof status.mtime === 'number' ? { mtime: status.mtime - ageMs } : {}),
      }),
    );
  }
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

function grokNativePromptText(row) {
  if (!Array.isArray(row?.content)) return null;
  const text = row.content
    .filter((item) => item?.type === 'text')
    .map((item) => item.text)
    .join('');
  const prefix = '<user_query>\n';
  const suffix = '\n</user_query>';
  return text.startsWith(prefix) && text.endsWith(suffix)
    ? text.slice(prefix.length, -suffix.length)
    : text;
}

function waitForGrokNativeTurn(sessionPath, prompt, afterPromptIndex, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const chatRows = readJsonl(path.join(sessionPath, 'chat_history.jsonl'));
    const promptRow = chatRows
      .filter(
        (row) =>
          row?.type === 'user' &&
          Number.isInteger(row.prompt_index) &&
          row.prompt_index > afterPromptIndex &&
          grokNativePromptText(row) === prompt,
      )
      .sort((a, b) => b.prompt_index - a.prompt_index)[0];
    if (promptRow) {
      const eventRows = readJsonl(path.join(sessionPath, 'events.jsonl'));
      const started = eventRows.find(
        (row) => row?.type === 'turn_started' && row.turn_number === promptRow.prompt_index,
      );
      const startedAt = Date.parse(started?.ts ?? '');
      const ended = eventRows.find(
        (row) => row?.type === 'turn_ended' && Date.parse(row.ts ?? '') >= startedAt,
      );
      if (started && ended) {
        return {
          promptIndex: promptRow.prompt_index,
          turnStartedAt: started.ts,
          turnEndedAt: ended.ts,
        };
      }
    }
    sleepMs(1000);
  }
  return null;
}

function createGrokSymlinkedSessionRoots(repo) {
  const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-validate-grok-sessions-'));
  const links = [];
  try {
    for (const key of grokSessionDirKeys(repo)) {
      const link = path.join(os.homedir(), '.grok', 'sessions', key);
      fs.mkdirSync(path.dirname(link), { recursive: true });
      if (fs.existsSync(link))
        throw new Error(`unexpected pre-existing Grok session root: ${link}`);
      fs.symlinkSync(targetRoot, link, 'dir');
      links.push(link);
    }
  } catch (error) {
    // Setup is atomic from the scenario's perspective: remove only the unique
    // roots this invocation created, then preserve the original failure.
    for (const link of links) fs.rmSync(link, { force: true });
    fs.rmSync(targetRoot, { recursive: true, force: true });
    throw error;
  }
  return {
    links,
    targetRoot,
    cleanup() {
      for (const link of links) fs.rmSync(link, { force: true });
      fs.rmSync(targetRoot, { recursive: true, force: true });
    },
  };
}

function waitForGrokSessionBinding({ repo, paneId, beforePaths, sinceMs, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const binding = resolveSessionBinding({
      runner: 'grok',
      repo,
      runtimeDir: '.agent',
      beforePaths,
      sinceMs,
      hookRows: [],
      paneId,
      slotId: 'runner-validate-local',
    });
    if (binding) return binding;
    sleepMs(500);
  }
  return null;
}

function runGrokScenario({ runnerAdapter, timeoutMs, keepSession, outDir }) {
  const runner = runnerAdapter.RUNNER_ID;
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-validate-grok-retained-send-'));
  const session = `runner-validate-grok-${SCENARIO_ID}-${process.pid}`;
  let symlinkedRoots = null;
  let paneId = null;
  const report = {
    runner,
    repo,
    session,
    initialCompleted: false,
    mismatchedSessionRejected: false,
    followupDelivered: false,
    followupAccepted: false,
    nativeInitialTurn: null,
    nativeFollowupTurn: null,
    sessionRootSymlinked: false,
    bindingIsRealpath: false,
    mismatchedSend: null,
    pass: false,
    error: null,
    paneTail: null,
  };

  try {
    runnerAdapter.prepareRepo(repo);
    symlinkedRoots = createGrokSymlinkedSessionRoots(repo);
    report.sessionRootSymlinked = symlinkedRoots.links.length > 0;
    const beforePaths = listSessionCandidates(runner, repo, '.agent');
    const shell = ensureShellSession(session, repo);
    paneId = shell.paneId;
    const dispatchMs = Date.now();
    sendShellScript(paneId, repo, [runnerAdapter.buildInteractiveLaunchCommand()]);
    const blockers = resolveLaunchBlockers(paneId, runner, Math.min(timeoutMs, 90_000));
    if (!blockers.resolved) throw new Error('Grok did not reach an interactive composer');
    sleepMs(2000);
    sendTmuxLine(paneId, DEFAULT_PROMPT);

    const binding = waitForGrokSessionBinding({
      repo,
      paneId,
      beforePaths,
      sinceMs: dispatchMs,
      timeoutMs: Math.min(timeoutMs, 30_000),
    });
    if (!binding?.runnerSessionId || !binding.runnerSessionPath) {
      throw new Error('Grok did not expose an exact retained session binding');
    }
    report.bindingIsRealpath =
      fs.realpathSync.native(binding.runnerSessionPath) === binding.runnerSessionPath;
    report.nativeInitialTurn = waitForGrokNativeTurn(
      binding.runnerSessionPath,
      DEFAULT_PROMPT,
      -1,
      timeoutMs,
    );
    report.initialCompleted = Boolean(report.nativeInitialTurn);
    if (!report.initialCompleted) {
      throw new Error('initial Grok turn lacked native start/end evidence');
    }
    sleepMs(1500);

    const mismatchedSend = runGatewaySafeInstruction({
      repo,
      target: paneId,
      runner,
      message: FOLLOWUP_PROMPT,
      sessionId: `${binding.runnerSessionId}-mismatch`,
      sessionPath: binding.runnerSessionPath,
      timeoutMs: 10_000,
    });
    report.mismatchedSend = mismatchedSend;
    report.mismatchedSessionRejected = mismatchedSend.result?.delivered === false;
    if (!report.mismatchedSessionRejected) {
      throw new Error(
        mismatchedSend.error || 'production safe-send accepted a mismatched Grok session binding',
      );
    }

    const safeSend = runGatewaySafeInstruction({
      repo,
      target: paneId,
      runner,
      message: FOLLOWUP_PROMPT,
      sessionId: binding.runnerSessionId,
      sessionPath: binding.runnerSessionPath,
      timeoutMs: Math.min(timeoutMs, 30_000),
    });
    report.followupDelivered = safeSend.result?.delivered === true;
    if (!report.followupDelivered) {
      throw new Error(safeSend.error || 'production safe-send rejected the exact Grok session');
    }
    report.nativeFollowupTurn = waitForGrokNativeTurn(
      binding.runnerSessionPath,
      FOLLOWUP_PROMPT,
      report.nativeInitialTurn.promptIndex,
      timeoutMs,
    );
    report.followupAccepted = Boolean(report.nativeFollowupTurn);
    report.pass =
      report.initialCompleted &&
      report.mismatchedSessionRejected &&
      report.followupDelivered &&
      report.followupAccepted;
  } catch (error) {
    report.error = error?.message || String(error);
    report.paneTail = paneId ? capturePaneBestEffort(paneId, 100) : null;
  } finally {
    if (!keepSession) {
      killSession(session);
      symlinkedRoots?.cleanup();
    }
  }

  const outPath = writeEvidence(report, SCENARIO_ID, runner, outDir);
  return { scenario: SCENARIO_ID, runner, outPath, pass: report.pass, report };
}

function runCodexScenario({ runnerAdapter, timeoutMs, keepSession, outDir }) {
  const runner = runnerAdapter.RUNNER_ID;
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-validate-codex-retained-send-'));
  const runtimeDir = '.agent';
  const slotId = `runner-validate-${os.hostname().replace(/\.local$/, '')}-codex`;
  const session = `runner-validate-codex-${SCENARIO_ID}-${process.pid}`;
  const logPath = path.join(obsDirFor(repo, runtimeDir), 'hooks.jsonl');
  let paneId = null;
  const report = {
    runner,
    repo,
    session,
    initialCompleted: false,
    filesystemSessionId: null,
    nativeSessionId: null,
    legacyBinding: null,
    legacyBindingUpgraded: false,
    mismatchedSessionRejected: false,
    followupDelivered: false,
    followupAccepted: false,
    nativeFollowupTurn: null,
    mismatchedSend: null,
    pass: false,
    error: null,
    paneTail: null,
  };

  try {
    runnerAdapter.prepareRepo(repo);
    installHooks(runner, repo, runtimeDir, slotId);
    const beforePaths = listSessionCandidates(runner, repo, runtimeDir);
    const shell = ensureShellSession(session, repo);
    paneId = shell.paneId;
    const dispatchMs = Date.now();
    const initialCount = readHookLines(logPath).length;
    sendShellScript(paneId, repo, [runnerAdapter.buildInteractiveLaunchCommand(repo, runtimeDir)]);
    sleepMs(2500);
    sendTmuxLine(paneId, DEFAULT_PROMPT);
    const initialRows = pollHookRows(logPath, initialCount, ['Stop'], timeoutMs);
    report.initialCompleted = initialRows.some((row) => eventName(row) === 'Stop');
    if (!report.initialCompleted) throw new Error('initial Codex turn did not emit Stop');

    const binding = resolveSessionBinding({
      runner,
      repo,
      runtimeDir,
      beforePaths,
      sinceMs: dispatchMs,
      hookRows: [],
      paneId,
      slotId,
    });
    if (!binding?.runnerSessionId || !binding.runnerSessionPath) {
      throw new Error('Codex filesystem fallback did not expose an exact retained session binding');
    }
    report.filesystemSessionId = binding.runnerSessionId;
    report.nativeSessionId = binding.runnerSessionId;
    const legacySessionId = path.basename(binding.runnerSessionPath, '.jsonl');
    const legacySessionPath = binding.runnerSessionPath.startsWith('/private/var/')
      ? binding.runnerSessionPath.replace(/^\/private\/var\//, '/var/')
      : binding.runnerSessionPath;
    report.legacyBinding = {
      sessionId: legacySessionId,
      sessionPath: legacySessionPath,
      format: 'pre-native-id-filesystem-binding',
    };
    sleepMs(1500);

    const mismatchedSend = runGatewaySafeInstruction({
      repo,
      target: paneId,
      runner,
      message: FOLLOWUP_PROMPT,
      sessionId: `${legacySessionId}-mismatch`,
      sessionPath: legacySessionPath,
      timeoutMs: 10_000,
    });
    report.mismatchedSend = mismatchedSend;
    report.mismatchedSessionRejected = mismatchedSend.result?.delivered === false;
    if (!report.mismatchedSessionRejected) {
      throw new Error(
        mismatchedSend.error ||
          'production CI-fix delivery accepted a mismatched Codex session binding',
      );
    }

    const followupCount = readHookLines(logPath).length;
    const safeSend = runGatewaySafeInstruction({
      repo,
      target: paneId,
      runner,
      message: FOLLOWUP_PROMPT,
      sessionId: legacySessionId,
      sessionPath: legacySessionPath,
      timeoutMs: Math.min(timeoutMs, 30_000),
    });
    report.followupDelivered = safeSend.result?.delivered === true;
    report.legacyBindingUpgraded = report.followupDelivered;
    if (!report.followupDelivered) {
      throw new Error(safeSend.error || 'production CI-fix delivery rejected exact Codex session');
    }
    const followupRows = pollHookRows(
      logPath,
      followupCount,
      ['UserPromptSubmit', 'Stop'],
      timeoutMs,
    );
    report.nativeFollowupTurn = hookDigestTurnEvidence(
      followupRows,
      digest.runnerPromptDigest(FOLLOWUP_PROMPT),
    );
    report.followupAccepted = Boolean(report.nativeFollowupTurn);
    report.pass =
      report.initialCompleted &&
      report.mismatchedSessionRejected &&
      report.followupDelivered &&
      report.legacyBindingUpgraded &&
      report.followupAccepted;
  } catch (error) {
    report.error = error?.message || String(error);
    report.paneTail = paneId ? capturePaneBestEffort(paneId, 100) : null;
  } finally {
    if (!keepSession) killSession(session);
  }

  const outPath = writeEvidence(report, SCENARIO_ID, runner, outDir);
  return { scenario: SCENARIO_ID, runner, outPath, pass: report.pass, report };
}

export async function runScenario({ runnerAdapter, timeoutMs, keepSession, outDir }) {
  const runner = runnerAdapter.RUNNER_ID;
  if (runner === 'grok') {
    return runGrokScenario({ runnerAdapter, timeoutMs, keepSession, outDir });
  }
  if (runner === 'codex') {
    return runCodexScenario({ runnerAdapter, timeoutMs, keepSession, outDir });
  }
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
  const foreignSession = `${session}-foreign`;
  const obsDir = obsDirFor(repo, runtimeDir);
  const logPath = path.join(obsDir, 'hooks.jsonl');
  let paneId = null;
  const report = {
    runner,
    repo,
    session,
    initialStopped: false,
    mismatchedSessionRejected: false,
    followupDelivered: false,
    followupAccepted: false,
    mismatchedSend: null,
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
    const stopRow = [...initialRows].reverse().find((row) => eventName(row) === 'Stop');
    report.initialStopped = Boolean(stopRow);
    if (!report.initialStopped) throw new Error('initial Claude turn did not emit Stop');
    const sessionId = stopRow?.session_id;
    const sessionPath = stopRow?.transcript_path;
    if (!sessionId || !sessionPath) {
      throw new Error('terminal hook did not expose an exact retained session binding');
    }

    const foreignShell = ensureShellSession(foreignSession, repo);
    const foreignCount = readHookLines(logPath).length;
    sendShellScript(foreignShell.paneId, repo, [command]);
    const foreignRows = pollHookRows(logPath, foreignCount, ['Stop'], timeoutMs);
    const foreignStop = [...foreignRows]
      .reverse()
      .find(
        (row) =>
          eventName(row) === 'Stop' &&
          row.tmuxPane === foreignShell.paneId &&
          row.session_id !== sessionId,
      );
    if (!foreignStop?.session_id || !foreignStop.transcript_path) {
      throw new Error('second Claude session did not expose an independent retained binding');
    }

    ageObservability(obsDir, paneId);
    const followupCount = readHookLines(logPath).length;
    const mismatchedSend = runGatewaySafeInstruction({
      repo,
      target: paneId,
      runner,
      message: FOLLOWUP_PROMPT,
      sessionId: foreignStop.session_id,
      sessionPath: foreignStop.transcript_path,
      timeoutMs: 10_000,
    });
    report.mismatchedSend = mismatchedSend;
    report.mismatchedSessionRejected = mismatchedSend.result?.delivered === false;
    if (!report.mismatchedSessionRejected) {
      throw new Error(
        mismatchedSend.error ||
          'production safe-send accepted a mismatched retained session binding',
      );
    }
    const safeSend = runGatewaySafeInstruction({
      repo,
      target: paneId,
      runner,
      message: FOLLOWUP_PROMPT,
      sessionId,
      sessionPath,
      timeoutMs: Math.min(timeoutMs, 10_000),
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
    report.pass =
      report.initialStopped &&
      report.mismatchedSessionRejected &&
      report.followupDelivered &&
      report.followupAccepted;
    report.paneTail = capturePaneBestEffort(paneId, 40);
  } catch (error) {
    report.error = error?.message || String(error);
    report.paneTail = paneId ? capturePaneBestEffort(paneId, 80) : null;
  } finally {
    if (!keepSession) {
      killSession(session);
      killSession(foreignSession);
    }
  }

  const outPath = writeEvidence(report, SCENARIO_ID, runner, outDir);
  return { scenario: SCENARIO_ID, runner, outPath, pass: report.pass, report };
}
