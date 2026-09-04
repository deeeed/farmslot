import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { ROOT, sleepMs } from '../lib/common.mjs';
import { evidencePath, writeEvidence } from '../lib/evidence.mjs';

export const SCENARIO_ID = 'session-reopen-smoke';
export const RUNNER_AGNOSTIC = true;

/**
 * Live proof that an operator can get back into the conversation a worker was
 * having. A Codex worker runs under an isolated CODEX_HOME, so `codex resume`
 * in a plain shell cannot find its session — the operator needs the exact
 * command the gateway builds.
 *
 * Spec AC6: this does not stop at the command text. It interrupts the worker
 * with the runner's own declared graceful-exit command, waits for structured
 * liveness to report the session gone, runs the gateway-built reopen command in
 * that same pane, and then requires `run.sessionCommand` to report `live` for
 * the SAME session id. Because liveness is backed by
 * `verifyExactLiveRunnerSessionBinding`, `live` proves the pane's runner owns
 * exactly the persisted session — that is the conversation-continuity proof.
 * Pane text is never consulted.
 *
 * Scope: this proves the launch capture and the reopen handle for one dev
 * dispatch. The branch-affinity nudge path is unit-covered
 * (services/gateway/src/runners/session-record.test.ts) rather than exercised
 * here, because reaching it live needs a second dispatch of the same family
 * onto the same slot while the first worker is still warm — a multi-run
 * sequence whose slot contention would make this scenario flaky without
 * proving anything the reopen handle does not already prove.
 */
function rpc(method, params = {}, timeoutMs = 120_000) {
  const script = path.join(ROOT, 'apps/command-center/scripts/cdp.mjs');
  const result = spawnSync('node', [script, 'gateway', method, JSON.stringify(params)], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: timeoutMs + 10_000,
    env: { ...process.env, FARMSLOT_RPC_TIMEOUT_MS: String(timeoutMs) },
  });
  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || result.stdout?.trim() || `${method} failed`);
  }
  // Void RPCs (terminal.send) answer with an empty body.
  const body = result.stdout?.trim();
  return body ? JSON.parse(body) : {};
}

async function poll(read, accept, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    latest = read();
    if (accept(latest)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`Timed out; latest=${JSON.stringify(latest)}`);
}

/**
 * Deliver one literal line to the worker's pane.
 *
 * `tmux.sendKeys` splits on whitespace and tmux concatenates the resulting
 * arguments, so it cannot carry a shell command verbatim — it is used only for
 * the single `Enter` token. `terminal.send` carries the exact text, and
 * `enter: false` keeps it usable after the runner exits, when the pane is a
 * plain shell with no runner context to validate against.
 */
function sendLine(slotId, runId, contextId, target, text, submitDelayMs = 300) {
  rpc('terminal.send', { slotId, runId, contextId, target, text, enter: false });
  sleepMs(Math.max(submitDelayMs, 300));
  rpc('tmux.sendKeys', { slotId, target, keys: 'Enter' });
  sleepMs(300);
}

/**
 * Paste one command into the slot session's CURRENT window as a single
 * bracketed paste, then submit.
 *
 * Typed delivery is chunked: the ~3 KB single-quoted reopen command arrives in
 * pieces and zsh can be left mid-string at a `quote>` continuation prompt with
 * nothing executed. A paste buffer is written once and pasted once, which is
 * what an operator's own paste does.
 */
function pasteCommandToCurrentWindow(slotId, text) {
  rpc('tmux.pasteText', { slotId, bareSession: true, text, submit: true });
  sleepMs(500);
}

/**
 * Structural check that the pasted command actually started something: a child
 * process must appear under the pane's shell. A shell stranded at a
 * continuation prompt has no child, so this fails in seconds instead of waiting
 * out the liveness poll. Pane text is never consulted.
 */
async function waitForPaneChildProcess(slotId, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() < deadline) {
    const panes = rpc('tmux.list', { slotId, bareSession: true });
    const active = (panes?.windows ?? [])
      .flatMap((window) => window.panes ?? [])
      .find((pane) => pane.active);
    latest = active ?? null;
    // `pane_current_command` moving off the login shell is the structural signal
    // that the pasted line is executing.
    if (
      active &&
      active.currentCommand &&
      !/^(zsh|bash|sh|-zsh|-bash)$/.test(active.currentCommand)
    ) {
      return { started: true, pane: active };
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return { started: false, pane: latest };
}

/**
 * Last lines of the window where the reopen was actually typed — the new
 * window, which `bareSession` resolves to because `tmux.newWindow` made it
 * current. Diagnostic only, never pass evidence.
 *
 * `terminal.snapshot` answers `{ lines: string[] }`; reading a `data`/`text`
 * field that does not exist is why an earlier run reported an empty tail for a
 * pane that had 40+ lines on it.
 */
function diagnosticPaneTail(slotId, lines = 40) {
  const snapshot = rpc('terminal.snapshot', { slotId, bareSession: true, lines });
  if (!Array.isArray(snapshot?.lines)) {
    throw new Error(
      `terminal.snapshot returned no lines array (keys: ${Object.keys(snapshot ?? {}).join(',') || 'none'})`,
    );
  }
  return snapshot.lines.slice(-lines).join('\n');
}

/** Index of the session's active window, read from structured tmux state. */
function activeWindowIndex(slotId) {
  const listed = rpc('tmux.list', { slotId, bareSession: true });
  const active = (listed?.windows ?? []).find((window) => window.active);
  return active ? active.index : null;
}

function capturedWorkerSession(run) {
  const contexts = run?.agentContexts ?? [];
  const withSession = contexts.find(
    (context) => context.runnerSessionId && context.runnerSessionPath,
  );
  return withSession ?? null;
}

export async function runScenario({ timeoutMs, outDir, slotId, taskFile, explicit = false }) {
  const reportRunner = 'codex';
  if (!slotId) {
    const requirement =
      'session-reopen-smoke needs --slot <slotId>; it dispatches a real codex worker and reopens its session';
    // Named on the command line, missing --slot is an operator error. Reached
    // through `--scenario all` there is nothing to supply, so it skips.
    if (explicit) {
      const report = { runner: reportRunner, pass: false, error: requirement };
      const outPath = writeEvidence(report, SCENARIO_ID, reportRunner, outDir);
      return { scenario: SCENARIO_ID, runner: reportRunner, outPath, pass: false, report };
    }
    // A skip carries no evidence about this machine, so it must never replace a
    // real run's evidence file with a stub.
    const existing = evidencePath(SCENARIO_ID, reportRunner, outDir);
    const report = { runner: reportRunner, skipped: true, skipReason: requirement, pass: true };
    const outPath = fs.existsSync(existing)
      ? existing
      : writeEvidence(report, SCENARIO_ID, reportRunner, outDir);
    return {
      scenario: SCENARIO_ID,
      runner: reportRunner,
      outPath,
      pass: true,
      skipped: true,
      report,
    };
  }

  const report = {
    runner: reportRunner,
    slotId,
    reopenWindowIndex: null,
    runId: null,
    capturedRole: null,
    capturedSessionId: null,
    capturedSessionPath: null,
    capturedAt: null,
    sessionCommandSupported: null,
    reopenCommand: null,
    attachCommand: null,
    tmuxTarget: null,
    interruptCommand: null,
    liveness: null,
    livenessAfterInterrupt: null,
    livenessReasonAfterInterrupt: null,
    livenessAfterReopen: null,
    reopenedSessionId: null,
    reopenedTmuxTarget: null,
    reopenedInNewWindow: false,
    reopenStartedCommand: false,
    reopenPaneCommand: null,
    targetWasRediscovered: false,
    diagnosticPaneTail: null,
    diagnosticPaneTailError: null,
    conversationContinued: false,
    pass: false,
    error: null,
  };
  let runId = null;
  let reopenWindowIndex = null;

  try {
    const fleet = rpc('fleet.status');
    const slot = fleet.fleet?.slots?.find((candidate) => candidate.slot === slotId);
    if (!slot) throw new Error(`slot ${slotId} not found in fleet.status`);
    report.project = slot.project;

    const created = rpc('run.create', {
      project: slot.project,
      flowType: 'dev',
      mode: 'interactive',
      ticketOrPr: 'runner session reopen validation',
      initialContext:
        'Validation run for the runner session reopen handle. Report the active model and stop; make no changes.',
      runner: reportRunner,
      slotId,
      skipPrepare: true,
      ...(taskFile ? { taskFile } : {}),
    });
    runId = created.run.id;
    report.runId = runId;

    // The session id lands on the agent context once dispatch captures it.
    const settled = await poll(
      () => rpc('run.get', { runId }).run,
      (state) =>
        Boolean(capturedWorkerSession(state)) ||
        ['failed', 'blocked', 'done', 'cancelled'].includes(state.status),
      timeoutMs,
    );
    const context = capturedWorkerSession(settled);
    if (!context) {
      throw new Error(
        `no agent context recorded a runner session (status=${settled.status}, contexts=${(settled.agentContexts ?? []).length})`,
      );
    }
    report.capturedRole = context.role;
    report.capturedSessionId = context.runnerSessionId;
    report.capturedSessionPath = context.runnerSessionPath;
    report.capturedAt = context.runnerSessionCapturedAt ?? null;
    if (!report.capturedAt) {
      throw new Error('agent context recorded a session without a capture timestamp');
    }

    const session = rpc('run.sessionCommand', { runId, contextId: context.id });
    report.sessionCommandSupported = session.supported === true;
    if (!session.supported) {
      throw new Error(
        `run.sessionCommand reported unsupported: ${session.reason} ${session.detail}`,
      );
    }
    report.reopenCommand = session.reopenCommand;
    report.attachCommand = session.attachCommand;
    report.liveness = session.liveness;

    if (session.sessionId !== context.runnerSessionId) {
      throw new Error(
        `run.sessionCommand returned session ${session.sessionId}, expected the captured ${context.runnerSessionId}`,
      );
    }
    if (!session.reopenCommand.includes(context.runnerSessionId)) {
      throw new Error(
        `reopen command does not reference the captured session id: ${session.reopenCommand}`,
      );
    }
    if (!/CODEX_HOME=/.test(session.reopenCommand)) {
      throw new Error(
        `reopen command does not carry the isolated CODEX_HOME setup: ${session.reopenCommand}`,
      );
    }
    if (!/\bresume\b/.test(session.reopenCommand)) {
      throw new Error(`reopen command is not a codex resume: ${session.reopenCommand}`);
    }
    if (!['live', 'dead', 'unknown'].includes(session.liveness)) {
      throw new Error(`run.sessionCommand returned an unknown liveness: ${session.liveness}`);
    }
    if (!session.attachCommand || !session.attachCommand.startsWith('tmux ')) {
      throw new Error(`attach command is not a tmux attach line: ${session.attachCommand}`);
    }
    if (!session.tmuxTarget) {
      throw new Error('run.sessionCommand returned no tmux target; cannot interrupt or reopen');
    }
    report.tmuxTarget = session.tmuxTarget;
    if (session.liveness !== 'live') {
      throw new Error(
        `worker is ${session.liveness} before the interrupt (${session.livenessReason ?? 'no reason'}); nothing to reopen`,
      );
    }

    // ---- interrupt --------------------------------------------------------
    // The stop input comes from the runner capability registry via
    // `run.sessionCommand`. A literal here would hardcode runner-specific
    // syntax outside the runner layer.
    if (!session.interrupt?.command) {
      throw new Error(
        `runner ${session.runner} declares no graceful exit; this scenario cannot interrupt it`,
      );
    }
    report.interruptCommand = session.interrupt.command;
    sendLine(
      slotId,
      runId,
      context.id,
      session.tmuxTarget,
      session.interrupt.command,
      session.interrupt.submitDelayMs,
    );

    // Only structured absence counts. `unknown` means the probe could not
    // decide, and accepting it would let the reopen "succeed" against a session
    // that was never actually interrupted.
    const interrupted = await poll(
      () => rpc('run.sessionCommand', { runId, contextId: context.id }),
      (state) => state.supported && state.liveness === 'dead',
      120_000,
    );
    report.livenessAfterInterrupt = interrupted.liveness;
    report.livenessReasonAfterInterrupt = interrupted.livenessReason ?? null;
    if (interrupted.sessionId !== context.runnerSessionId) {
      throw new Error(
        `interrupt changed the recorded session id to ${interrupted.sessionId}; the handle must survive an interrupt`,
      );
    }

    // ---- reopen -----------------------------------------------------------
    // The interrupt destroyed the role window, so open a fresh one and paste
    // there — exactly what an operator does. Nothing is reassembled here: this
    // is the gateway's own command string.
    rpc('tmux.newWindow', { slotId, bareSession: true });
    sleepMs(500);
    report.reopenedInNewWindow = true;
    // Remember the window so the scenario does not leave one behind on every
    // run; without this the slot accumulates idle reopen windows.
    reopenWindowIndex = activeWindowIndex(slotId);
    report.reopenWindowIndex = reopenWindowIndex;
    pasteCommandToCurrentWindow(slotId, session.reopenCommand);

    // Fail fast on a shell that never started the command, rather than burning
    // the liveness timeout on a pane that is stuck at a continuation prompt.
    const started = await waitForPaneChildProcess(slotId);
    report.reopenStartedCommand = started.started;
    report.reopenPaneCommand = started.pane?.currentCommand ?? null;
    if (!started.started) {
      report.diagnosticPaneTail = diagnosticPaneTail(slotId);
      throw new Error(
        `pasted reopen command never started a process (pane command: ${report.reopenPaneCommand ?? 'unknown'})`,
      );
    }

    let reopened;
    try {
      reopened = await poll(
        () => rpc('run.sessionCommand', { runId, contextId: context.id }),
        (state) => state.supported && state.liveness === 'live',
        180_000,
      );
    } catch (pollError) {
      // Diagnostic only: the pane text explains WHY the reopen did not take,
      // and is never used as evidence that it did. A capture that itself fails
      // is recorded loudly rather than silently yielding an empty tail.
      try {
        report.diagnosticPaneTail = diagnosticPaneTail(slotId);
        if (!report.diagnosticPaneTail.trim()) {
          report.diagnosticPaneTailError = 'pane snapshot returned only blank lines';
        }
      } catch (captureError) {
        report.diagnosticPaneTailError = captureError?.message || String(captureError);
      }
      throw pollError;
    }
    report.livenessAfterReopen = reopened.liveness;
    report.reopenedSessionId = reopened.sessionId;
    report.reopenedTmuxTarget = reopened.tmuxTarget;
    report.targetWasRediscovered = reopened.rediscoveredTarget === true;
    if (!reopened.tmuxTarget) {
      throw new Error('reopened session reports no tmux target; Command Center cannot follow it');
    }
    // `live` here is not "a codex process exists": the gateway proved the pane's
    // active runner session is exactly this id and path.
    if (reopened.sessionId !== context.runnerSessionId) {
      throw new Error(
        `reopen produced session ${reopened.sessionId}, expected the original ${context.runnerSessionId}; the conversation did not continue`,
      );
    }
    report.conversationContinued = true;
    report.pass = true;
  } catch (error) {
    report.error = error?.message || String(error);
  } finally {
    if (reopenWindowIndex !== null) {
      // The reopened runner is cancelled with the run; the window it lived in
      // is this scenario's litter and is its own to clear.
      try {
        rpc('tmux.killPane', { slotId, target: `${reopenWindowIndex}` });
        report.reopenWindowClosed = true;
      } catch (closeError) {
        report.reopenWindowClosed = false;
        report.reopenWindowCloseError = closeError?.message || String(closeError);
      }
    }
    if (runId) {
      // A validation run that outlives the scenario holds a real slot. Report
      // the leaked runId so the operator can cancel it by hand.
      try {
        const cancelResult = rpc('run.cancel', {
          runId,
          reason: `${SCENARIO_ID} validation complete`,
        });
        const failedEffects = (cancelResult?.effects ?? []).filter(
          (effect) => effect.status === 'failed',
        );
        report.cancelEffects = (cancelResult?.effects ?? []).map((effect) => ({
          name: effect.name,
          status: effect.status,
        }));
        const after = rpc('run.get', { runId }).run;
        report.finalStatus = after?.status ?? null;
        const releaseDeadline = Date.now() + 10_000;
        let slotOwner = null;
        for (;;) {
          slotOwner = rpc('fleet.status').fleet?.slots?.find(
            (candidate) => candidate.slot === slotId,
          )?.currentRunId;
          if (slotOwner !== runId || Date.now() >= releaseDeadline) break;
          sleepMs(500);
        }
        report.slotReleased = slotOwner !== runId;
        report.cancelled =
          after?.status === 'cancelled' && failedEffects.length === 0 && report.slotReleased;
        if (!report.cancelled) {
          report.pass = false;
          report.leakedRunId = runId;
          report.cancelError =
            failedEffects.length > 0
              ? `run.cancel reported failed effect(s): ${failedEffects.map((effect) => effect.name).join(', ')}`
              : !report.slotReleased
                ? `slot ${slotId} still reports currentRunId ${runId} after cancel`
                : `run ${runId} is ${report.finalStatus ?? 'unreadable'} after cancel, expected cancelled`;
          report.error = report.error ?? report.cancelError;
        }
      } catch (cancelError) {
        report.pass = false;
        report.cancelled = false;
        report.leakedRunId = runId;
        report.cancelError = cancelError?.message || String(cancelError);
        report.error = report.error ?? report.cancelError;
      }
    }
  }

  const outPath = writeEvidence(report, SCENARIO_ID, reportRunner, outDir);
  return { scenario: SCENARIO_ID, runner: reportRunner, outPath, pass: report.pass, report };
}
