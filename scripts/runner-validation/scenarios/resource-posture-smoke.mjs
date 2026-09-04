import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { ROOT } from '../lib/common.mjs';
import { writeEvidence } from '../lib/evidence.mjs';

export const SCENARIO_ID = 'resource-posture-smoke';
export const RUNNER_AGNOSTIC = true;

/**
 * Live proof of the ADR-054 run resource posture through the production
 * gateway: a real run acquires a real project capability through the same
 * `runtime.capability.acquire` RPC the worker uses, then `runtime.posture.apply`
 * drives that run through `operator-wait` and `terminal` while
 * `runtime.posture.status` reports desired disposition against observed
 * provider state.
 *
 * It asserts on gateway RPC results and the persisted run record, never on pane
 * text. The run is a scripted `mode: validation` dispatch so no LLM turn is
 * spent, and it is cancelled at the end with the same slot-release proof the
 * other dispatch scenarios use.
 *
 * Capability choice: `farmslot-farm` declares no `low` cost provider, so this
 * uses the cheapest one that is safe to drive live — `sandbox-gateway-ui`
 * (medium cost, shared, and its release action deliberately retains the
 * control-plane process). Medium and low take the same framework retain path at
 * `operator-wait`; only `high` is shed.
 */
const CAPABILITY_ID = 'sandbox-gateway-ui';

function rpc(method, params = {}, timeoutMs = 120_000) {
  const script = path.join(ROOT, 'apps/command-center/scripts/cdp.mjs');
  const result = spawnSync('node', [script, 'gateway', method, JSON.stringify(params)], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: timeoutMs + 10_000,
    env: { ...process.env, FARMSLOT_RPC_TIMEOUT_MS: String(timeoutMs) },
  });
  const stdout = result.stdout?.trim() ?? '';
  if (result.status !== 0) {
    throw new Error(
      `Gateway RPC ${method} failed (exit ${result.status}): ${result.stderr?.trim() || stdout || 'gateway unavailable'}`,
    );
  }
  return JSON.parse(stdout);
}

async function poll(description, read, accept, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    latest = read();
    if (accept(latest)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${description}; latest=${JSON.stringify(latest)}`);
}

function capabilityState(status, capabilityId) {
  return status.state.capabilities.find((entry) => entry.capabilityId === capabilityId) ?? null;
}

export async function runScenario({ timeoutMs, outDir, slotId, explicit = false }) {
  const reportRunner = 'scripted';
  if (!slotId || process.env.FARMSLOT_ENABLE_SCRIPTED_SCENARIOS !== '1') {
    const requirement =
      'resource-posture-smoke needs --slot <farmslot-farm slotId> and FARMSLOT_ENABLE_SCRIPTED_SCENARIOS=1; it dispatches a real scripted validation run';
    const report = explicit
      ? { runner: reportRunner, pass: false, error: requirement }
      : { runner: reportRunner, skipped: true, skipReason: requirement, pass: true };
    const outPath = writeEvidence(report, SCENARIO_ID, reportRunner, outDir);
    return {
      scenario: SCENARIO_ID,
      runner: reportRunner,
      outPath,
      pass: report.pass,
      ...(explicit ? {} : { skipped: true }),
      report,
    };
  }

  const report = {
    runner: reportRunner,
    slotId,
    capabilityId: CAPABILITY_ID,
    runId: null,
    project: null,
    acquire: null,
    waitPreview: null,
    waitApply: null,
    waitStatus: null,
    terminalApply: null,
    terminalStatus: null,
    persistedPosture: null,
    pass: false,
    error: null,
  };
  let runId = null;

  try {
    const fleet = rpc('fleet.status');
    const slot = fleet.fleet?.slots?.find((candidate) => candidate.slot === slotId);
    if (!slot) throw new Error(`slot ${slotId} not found in fleet.status`);
    report.project = slot.project;
    if (slot.project !== 'farmslot-farm') {
      throw new Error(`slot ${slotId} runs project ${slot.project}; expected farmslot-farm`);
    }

    const created = rpc('run.create', {
      project: slot.project,
      flowType: 'dev',
      mode: 'validation',
      ticketOrPr: 'resource posture validation',
      initialContext: 'Resource posture validation run. Makes no changes.',
      runner: 'scripted',
      scripted: { mode: 'scenario', scenario: 'success', stepDelayMs: 2000 },
      slotId,
      skipPrepare: true,
    });
    runId = created.run.id;
    report.runId = runId;

    await poll(
      'the run to bind its slot',
      () => rpc('run.get', { runId }).run,
      (state) => state.slotId === slotId,
      timeoutMs,
    );

    // The worker path: the same acquire RPC a worker calls from its proof plan.
    const acquired = rpc('runtime.capability.acquire', {
      slotId,
      capabilityId: CAPABILITY_ID,
      ownerRunId: runId,
      proofRequirement: {
        capabilityId: CAPABILITY_ID,
        reason: 'resource posture live validation',
        mode: 'state',
      },
    });
    report.acquire = { ok: acquired.ok, leaseState: acquired.lease?.state ?? null };
    if (!acquired.ok) {
      throw new Error(`capability acquire failed: ${acquired.conflict?.reason ?? 'unknown'}`);
    }

    // Preview must describe the exact effect before anything is applied.
    const waitPreview = rpc('runtime.posture.preview', { runId, posture: 'operator-wait' });
    report.waitPreview = {
      posture: waitPreview.posture,
      policySource: waitPreview.policySource,
      retain: waitPreview.retain.map((state) => state.capabilityId),
      warm: waitPreview.warm.map((state) => state.capabilityId),
      stop: waitPreview.stop.map((state) => state.capabilityId),
      effects: waitPreview.effects,
    };
    if (waitPreview.posture !== 'operator-wait') {
      throw new Error(`preview resolved posture ${waitPreview.posture}, expected operator-wait`);
    }

    const waitApply = rpc('runtime.posture.apply', {
      runId,
      posture: 'operator-wait',
      operationId: `${SCENARIO_ID}-wait-${process.pid}`,
    });
    report.waitApply = {
      ok: waitApply.ok,
      outcome: waitApply.transition.outcome,
      policySource: waitApply.transition.policySource,
    };
    if (!waitApply.ok) {
      throw new Error(`operator-wait apply failed: ${JSON.stringify(waitApply.transition)}`);
    }

    const waitStatus = rpc('runtime.posture.status', { runId });
    const waitState = capabilityState(waitStatus, CAPABILITY_ID);
    report.waitStatus = waitState;
    if (!waitState) throw new Error(`posture status reported no state for ${CAPABILITY_ID}`);
    // A medium-cost provider stays usable for the next operator action.
    if (waitState.desiredDisposition !== 'acquired') {
      throw new Error(
        `expected ${CAPABILITY_ID} desired 'acquired' at operator-wait, got '${waitState.desiredDisposition}'`,
      );
    }
    if (waitState.observedState !== 'running') {
      throw new Error(`expected observed 'running', got '${waitState.observedState}'`);
    }
    if (waitStatus.state.workerRetained !== true) {
      throw new Error('operator-wait must never report the worker as stopped');
    }

    const terminalApply = rpc('runtime.posture.apply', {
      runId,
      posture: 'terminal',
      operationId: `${SCENARIO_ID}-terminal-${process.pid}`,
    });
    report.terminalApply = {
      ok: terminalApply.ok,
      outcome: terminalApply.transition.outcome,
      effects: terminalApply.transition.effects,
      failures: terminalApply.transition.failures,
    };
    if (!terminalApply.ok) {
      throw new Error(`terminal apply failed: ${JSON.stringify(terminalApply.transition)}`);
    }

    const terminalStatus = rpc('runtime.posture.status', { runId });
    const terminalState = capabilityState(terminalStatus, CAPABILITY_ID);
    report.terminalStatus = terminalState;
    if (terminalState?.desiredDisposition !== 'stopped') {
      throw new Error(
        `expected ${CAPABILITY_ID} desired 'stopped' at terminal, got '${terminalState?.desiredDisposition}'`,
      );
    }
    if (terminalState.observedState !== 'stopped') {
      throw new Error(
        `expected observed 'stopped' at terminal, got '${terminalState.observedState}'`,
      );
    }

    // Repeating the same posture must be idempotent, not a second stop.
    const repeat = rpc('runtime.posture.apply', { runId, posture: 'terminal' });
    report.terminalRepeatOutcome = repeat.transition.outcome;
    if (repeat.transition.outcome !== 'idempotent') {
      throw new Error(
        `repeat terminal reported '${repeat.transition.outcome}', expected idempotent`,
      );
    }

    // The posture is durable on the run, so a reconnecting client sees it.
    const persisted = rpc('run.get', { runId }).run.resourcePosture ?? null;
    report.persistedPosture = persisted
      ? {
          posture: persisted.posture,
          policySource: persisted.policySource,
          lastTransition: persisted.lastTransition?.outcome ?? null,
        }
      : null;
    if (persisted?.posture !== 'terminal') {
      throw new Error(
        `run record did not persist the terminal posture: ${JSON.stringify(persisted)}`,
      );
    }

    report.pass = true;
  } catch (error) {
    report.error = error?.message || String(error);
  } finally {
    if (runId) {
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
          await new Promise((resolve) => setTimeout(resolve, 500));
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
