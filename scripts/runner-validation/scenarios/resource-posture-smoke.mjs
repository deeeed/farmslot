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
 * text. The run is a scripted interactive-start dispatch so no LLM turn is
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

/** Booting a simulator plus Metro is minutes, not seconds. */
const SLOW_RPC_TIMEOUT_MS = 480_000;

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

/**
 * The shallowest, cheapest dependent pair in this slot's catalog. Chosen from
 * the live catalog rather than hardcoded so the scenario follows the project's
 * own configuration.
 *
 * "Shallowest" is load-bearing: `companion-native-client-ios -> ios-simulator`
 * costs the same by cost class as `ios-simulator -> companion-metro`, but the
 * first drags in a whole native client build. So a dependent that itself depends
 * on another dependent is never chosen — the pair must sit at depth 1, with a
 * dependency that has no dependencies of its own.
 */
function findDependentPair(capabilities) {
  const byId = new Map(capabilities.map((entry) => [entry.id, entry]));
  const cost = { low: 0, medium: 1, high: 2 };
  const available = (entry) => entry && entry.availability.state === 'available';
  const candidates = capabilities
    .filter((entry) => (entry.dependencies ?? []).length === 1)
    .map((entry) => ({ dependent: entry, dependency: byId.get(entry.dependencies[0]) }))
    .filter(
      (pair) =>
        available(pair.dependent) &&
        available(pair.dependency) &&
        // Depth 1 only: the dependency must be a leaf.
        (pair.dependency.dependencies ?? []).length === 0,
    );
  const totalCost = (pair) => cost[pair.dependent.cost.class] + cost[pair.dependency.cost.class];
  candidates.sort(
    (a, b) => totalCost(a) - totalCost(b) || a.dependent.id.localeCompare(b.dependent.id),
  );
  const chosen = candidates[0];
  if (!chosen) return null;
  return {
    ...chosen,
    why:
      `depth-1 pair with the lowest total cost class (${chosen.dependent.cost.class} + ` +
      `${chosen.dependency.cost.class}); rejected ${capabilities.filter((entry) => (entry.dependencies ?? []).length > 0).length - candidates.length} ` +
      'deeper or unavailable candidate(s)',
  };
}

/** Lifecycle event order is the Gateway's own record of what it stopped when. */
function releaseOrderFromEvents(status, capabilityIds) {
  return status.events
    .filter((event) => event.kind === 'released' && capabilityIds.includes(event.capabilityId))
    .map((event) => event.capabilityId);
}

/**
 * Acquire a capability that declares a dependency, drive the run through
 * `operator-wait` and `terminal`, and assert from `runtime.posture.status` that
 * both leases match policy and that the dependent stops before the dependency.
 *
 * Every dependent pair this project declares bottoms out at a device provider,
 * so this boots real resources. Set FARMSLOT_POSTURE_SKIP_DEPENDENCY_PROOF=1 to
 * record it as skipped instead; the skip is reported, never silently passed.
 */
async function proveDependencyPosture({ slotId, runId, report, acquireBudgetMs }) {
  const proof = { attempted: false, pass: false, reason: null, error: null };
  if (process.env.FARMSLOT_POSTURE_SKIP_DEPENDENCY_PROOF === '1') {
    proof.reason = 'skipped by FARMSLOT_POSTURE_SKIP_DEPENDENCY_PROOF=1';
    return proof;
  }
  const catalog = rpc('runtime.capability.list', { slotId });
  const pair = findDependentPair(catalog.capabilities ?? []);
  if (!pair) {
    proof.reason = `no available dependent capability pair in the ${report.project} catalog for ${slotId}`;
    return proof;
  }
  proof.attempted = true;
  proof.dependent = pair.dependent.id;
  proof.dependency = pair.dependency.id;
  proof.pairReason = pair.why;
  proof.candidates = (catalog.capabilities ?? [])
    .filter((entry) => (entry.dependencies ?? []).length > 0)
    .map((entry) => ({
      id: entry.id,
      dependencies: entry.dependencies,
      cost: entry.cost.class,
      availability: entry.availability.state,
    }));
  try {
    // Acquiring the dependent implicitly acquires its dependency. Booting a
    // simulator and Metro takes minutes, so this gets its own RPC budget; if the
    // client still gives up, the gateway may well be mid-acquire, so fall back
    // to polling lease state rather than declaring failure on a client timeout.
    let acquireError = null;
    try {
      const acquired = rpc(
        'runtime.capability.acquire',
        {
          slotId,
          capabilityId: pair.dependent.id,
          ownerRunId: runId,
          proofRequirement: {
            capabilityId: pair.dependent.id,
            reason: 'resource posture dependency validation',
            mode: 'state',
          },
        },
        Math.max(SLOW_RPC_TIMEOUT_MS, acquireBudgetMs),
      );
      if (!acquired.ok) {
        throw new Error(`acquire failed: ${acquired.conflict?.reason ?? 'unknown'}`);
      }
    } catch (error) {
      acquireError = error?.message || String(error);
      proof.acquireClientError = acquireError;
    }

    // Lease state is the authority, not the RPC's return: the gateway keeps
    // acquiring after a client timeout.
    const acquiredLeases = await poll(
      `${pair.dependent.id} and ${pair.dependency.id} to reach acquired`,
      () => rpc('runtime.capability.status', { slotId, ownerRunId: runId }).leases,
      (leases) =>
        [pair.dependent.id, pair.dependency.id].every((id) =>
          leases.some((lease) => lease.capabilityId === id && lease.state === 'acquired'),
        ),
      acquireBudgetMs,
    ).catch((error) => {
      throw new Error(
        acquireError
          ? `${acquireError}; lease never reached acquired: ${error.message}`
          : error.message,
      );
    });
    proof.dependencyLeaseAcquired = acquiredLeases.some(
      (lease) => lease.capabilityId === pair.dependency.id && lease.state === 'acquired',
    );
    if (!proof.dependencyLeaseAcquired) {
      throw new Error(`acquiring ${pair.dependent.id} did not acquire ${pair.dependency.id}`);
    }

    const waitApply = rpc(
      'runtime.posture.apply',
      { runId, posture: 'operator-wait', operationId: `${SCENARIO_ID}-dep-wait-${process.pid}` },
      SLOW_RPC_TIMEOUT_MS,
    );
    if (!waitApply.ok) {
      throw new Error(`operator-wait apply failed: ${JSON.stringify(waitApply.transition)}`);
    }
    const waitStatus = rpc('runtime.posture.status', { runId });
    proof.waitStates = [pair.dependent.id, pair.dependency.id].map((id) => {
      const state = capabilityState(waitStatus, id);
      if (!state) throw new Error(`posture status reported no state for ${id}`);
      return {
        capabilityId: id,
        desiredDisposition: state.desiredDisposition,
        observedState: state.observedState,
        policySource: state.policySource,
      };
    });
    for (const state of proof.waitStates) {
      // Desired and observed must agree: acquired/warm means a live provider,
      // stopped means a stopped one.
      const live = state.observedState === 'running';
      if (state.desiredDisposition === 'acquired' && !live) {
        throw new Error(
          `${state.capabilityId} is desired acquired but observed ${state.observedState}`,
        );
      }
      if (state.desiredDisposition === 'stopped' && state.observedState !== 'stopped') {
        throw new Error(
          `${state.capabilityId} is desired stopped but observed ${state.observedState}`,
        );
      }
    }

    const terminalApply = rpc(
      'runtime.posture.apply',
      { runId, posture: 'terminal', operationId: `${SCENARIO_ID}-dep-terminal-${process.pid}` },
      SLOW_RPC_TIMEOUT_MS,
    );
    if (!terminalApply.ok) {
      throw new Error(`terminal apply failed: ${JSON.stringify(terminalApply.transition)}`);
    }
    const terminalStatus = rpc('runtime.posture.status', { runId });
    proof.terminalStates = [pair.dependent.id, pair.dependency.id].map((id) => {
      const state = capabilityState(terminalStatus, id);
      return {
        capabilityId: id,
        desiredDisposition: state?.desiredDisposition ?? null,
        observedState: state?.observedState ?? null,
      };
    });
    for (const state of proof.terminalStates) {
      if (state.desiredDisposition !== 'stopped' || state.observedState !== 'stopped') {
        throw new Error(
          `${state.capabilityId} ended ${state.desiredDisposition}/${state.observedState}, expected stopped/stopped`,
        );
      }
    }

    // The Gateway's own lifecycle events record the order it stopped them in.
    const capabilityStatus = rpc('runtime.capability.status', { slotId, ownerRunId: runId });
    const order = releaseOrderFromEvents(capabilityStatus, [pair.dependent.id, pair.dependency.id]);
    proof.releaseOrder = order;
    const dependentAt = order.indexOf(pair.dependent.id);
    const dependencyAt = order.lastIndexOf(pair.dependency.id);
    if (dependentAt === -1 || dependencyAt === -1) {
      throw new Error(`missing release events for the pair: ${order.join(', ')}`);
    }
    if (dependentAt > dependencyAt) {
      throw new Error(
        `${pair.dependency.id} was released before ${pair.dependent.id}: ${order.join(', ')}`,
      );
    }
    proof.pass = true;
  } catch (error) {
    proof.error = error?.message || String(error);
    // Whatever went wrong, anything this proof booted must still come down.
    // Recorded, not swallowed: the outcome lands in the evidence either way.
    try {
      const salvage = rpc(
        'runtime.posture.apply',
        { runId, posture: 'terminal', operationId: `${SCENARIO_ID}-dep-salvage-${process.pid}` },
        SLOW_RPC_TIMEOUT_MS,
      );
      proof.salvageTerminal = salvage.transition.outcome;
    } catch (salvageError) {
      proof.salvageTerminalError = salvageError?.message || String(salvageError);
    }
  }
  return proof;
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
    dependencyProof: null,
    leftoverLeases: null,
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
      // Free-text tickets are accepted only by flexible interactive starts;
      // the scripted runner still makes no changes.
      mode: 'interactive',
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

    // ADR-054 dependency ordering, proved live against the project's own catalog.
    report.dependencyProof = await proveDependencyPosture({
      slotId,
      runId,
      report,
      // Respect the operator's --timeout-ms while allowing a real device boot.
      acquireBudgetMs: Math.max(timeoutMs, SLOW_RPC_TIMEOUT_MS),
    });
    if (report.dependencyProof.attempted && !report.dependencyProof.pass) {
      throw new Error(`dependency posture proof failed: ${report.dependencyProof.error}`);
    }

    report.pass = true;
  } catch (error) {
    report.error = error?.message || String(error);
  } finally {
    if (runId) {
      try {
        const cancelResult = rpc(
          'run.cancel',
          { runId, reason: `${SCENARIO_ID} validation complete` },
          SLOW_RPC_TIMEOUT_MS,
        );
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

        // Cancel routes through the ADR-054 terminal reconcile, so nothing this
        // run acquired may still be held. This is the durable answer to "did a
        // timed-out acquire leak a provider".
        try {
          const leases = rpc('runtime.capability.status', { slotId, ownerRunId: runId }).leases;
          report.leftoverLeases = leases
            .filter((lease) => ['acquiring', 'acquired', 'releasing'].includes(lease.state))
            .map((lease) => ({
              capabilityId: lease.capabilityId,
              state: lease.state,
              cleanupFailure: lease.cleanupFailure ?? null,
            }));
        } catch (leaseError) {
          report.leftoverLeasesError = leaseError?.message || String(leaseError);
          report.leftoverLeases = null;
        }
        if (report.leftoverLeases === null || report.leftoverLeases.length > 0) {
          report.pass = false;
          report.error =
            report.error ??
            (report.leftoverLeases === null
              ? `could not verify leftover leases: ${report.leftoverLeasesError}`
              : `run still holds ${report.leftoverLeases.length} lease(s) after cancel: ` +
                report.leftoverLeases.map((lease) => lease.capabilityId).join(', '));
        }

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
