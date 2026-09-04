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
 * This asserts on the persisted capture and the gateway-built command:
 * `run.sessionCommand` must name the session id that dispatch recorded on the
 * worker's agent context, and must carry the isolated CODEX_HOME setup. Pane
 * text is never consulted.
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
  return JSON.parse(result.stdout);
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
    runId: null,
    capturedRole: null,
    capturedSessionId: null,
    capturedSessionPath: null,
    capturedAt: null,
    sessionCommandSupported: null,
    reopenCommand: null,
    attachCommand: null,
    liveness: null,
    pass: false,
    error: null,
  };
  let runId = null;

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

    const session = rpc('run.sessionCommand', { runId, role: context.role });
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
    report.pass = true;
  } catch (error) {
    report.error = error?.message || String(error);
  } finally {
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
