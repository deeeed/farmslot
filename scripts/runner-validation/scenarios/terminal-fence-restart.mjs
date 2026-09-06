import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { ROOT } from '../lib/common.mjs';
import { writeEvidence } from '../lib/evidence.mjs';

export const SCENARIO_ID = 'terminal-fence-restart';
export const RUNNER_AGNOSTIC = true;

/**
 * Live proof that the ADR-054 terminal capability fence survives a gateway
 * restart (MANUAL-000118).
 *
 * The fence used to be an in-memory Set: once a run had its terminal capability
 * cleanup, later acquires for that owner or its family were refused — but only
 * until the process was replaced. A restart came back with an empty fence and
 * would hand a provider to a run that is already gone, which nothing would ever
 * release.
 *
 * Everything here goes through the production gateway RPCs a client uses:
 * `runtime.capability.acquire`, `runtime.posture.apply`, `runtime.capability.status`.
 * No pane text, no unit doubles.
 *
 * The restart is REAL but it is the dev `tsx watch` supervisor's, not a
 * `farmslot up` restart: touching a gateway source file makes the supervisor
 * replace the process. It is proven by the LISTENER PID changing, recorded in
 * the evidence, and it kills operator sessions on this gateway — so the
 * scenario refuses to run while any other run is active.
 *
 * Capability choice matches resource-posture-smoke: `sandbox-gateway-ui` is the
 * cheapest provider on farmslot-farm that is safe to drive live, and its
 * release action deliberately retains the control-plane process.
 */
const CAPABILITY_ID = 'sandbox-gateway-ui';

/** The gateway file whose mtime the dev supervisor watches to restart. */
const RESTART_TRIGGER = 'services/gateway/src/index.ts';

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

function tryRpc(method, params = {}, timeoutMs = 15_000) {
  try {
    return { ok: true, value: rpc(method, params, timeoutMs) };
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) };
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The gateway's own listening port, from the URL every other client uses. */
function gatewayPort() {
  const url = new URL(process.env.FARMSLOT_GATEWAY ?? 'ws://localhost:7777');
  return url.port || '7777';
}

/**
 * The PID actually listening on the gateway port.
 *
 * This is the restart proof. A "the RPC answered again" check proves nothing —
 * it answers the whole time if the supervisor never replaced the process.
 */
function listenerPid() {
  const result = spawnSync('lsof', ['-nP', `-iTCP:${gatewayPort()}`, '-sTCP:LISTEN', '-t'], {
    encoding: 'utf8',
  });
  const pid = (result.stdout ?? '').trim().split('\n')[0]?.trim();
  return pid || null;
}

/**
 * Acquire, riding out machine pressure.
 *
 * Admission refuses a medium-cost provider while the host is at critical
 * pressure, and this farm's node runs many agents at once — so a pressure
 * refusal is a fact about the machine at that second, not a verdict about the
 * fence. Branches on the conflict KIND the gateway already returns, never on
 * the reason prose: load, memory, and disk each word it differently, and a
 * regex over them silently stopped retrying when the wording moved. Every other
 * conflict is returned unchanged, so a real refusal is never waited away.
 */
async function acquireThroughPressure(slotId, ownerRunId, ownerFamilyId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let latest = acquire(slotId, ownerRunId, ownerFamilyId);
  while (!latest.ok && latest.conflict?.kind === 'host-pressure' && Date.now() < deadline) {
    await sleep(15_000);
    latest = acquire(slotId, ownerRunId, ownerFamilyId);
  }
  return latest;
}

function acquire(slotId, ownerRunId, ownerFamilyId) {
  return rpc('runtime.capability.acquire', {
    slotId,
    capabilityId: CAPABILITY_ID,
    ownerRunId,
    ...(ownerFamilyId ? { ownerFamilyId } : {}),
    proofRequirement: {
      capabilityId: CAPABILITY_ID,
      reason: 'terminal fence restart validation',
      mode: 'state',
    },
  });
}

function createScriptedRun(slotId, project, familyId) {
  const created = rpc('run.create', {
    project,
    flowType: 'dev',
    mode: 'interactive',
    ticketOrPr: 'terminal fence restart validation',
    initialContext: 'Terminal capability fence validation run. Makes no changes.',
    runner: 'scripted',
    scripted: { mode: 'scenario', scenario: 'success', stepDelayMs: 2000 },
    slotId,
    skipPrepare: true,
    ...(familyId ? { familyId } : {}),
  });
  return created.run;
}

async function pollFor(description, read, accept, timeoutMs, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    latest = read();
    if (accept(latest)) return latest;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for ${description}; latest=${JSON.stringify(latest)}`);
}

/**
 * Replace the gateway process through the dev supervisor and wait for the new
 * one to serve RPC. Returns both PIDs so the evidence records the proof.
 */
async function restartGateway(timeoutMs) {
  const before = listenerPid();
  if (!before) throw new Error(`no process is listening on gateway port ${gatewayPort()}`);
  // `touch` only: the file's CONTENT must not change, or the restart would also
  // be a code change and the fence proof would be about something else.
  const touched = spawnSync('touch', [path.join(ROOT, RESTART_TRIGGER)], { encoding: 'utf8' });
  if (touched.status !== 0) {
    throw new Error(`could not touch ${RESTART_TRIGGER}: ${touched.stderr ?? ''}`);
  }
  const deadline = Date.now() + timeoutMs;
  let after = before;
  while (Date.now() < deadline) {
    await sleep(500);
    const current = listenerPid();
    if (current && current !== before) {
      // A new listener is not yet a serving gateway; wait for it to answer.
      const probe = tryRpc('fleet.status', {}, 15_000);
      if (probe.ok) {
        after = current;
        break;
      }
    }
  }
  if (after === before) {
    throw new Error(
      `gateway listener pid never changed from ${before}; the dev supervisor did not restart it`,
    );
  }
  return { before, after };
}

export async function runScenario({ timeoutMs, outDir, slotId, explicit = false }) {
  const reportRunner = 'scripted';
  if (!slotId || process.env.FARMSLOT_ENABLE_SCRIPTED_SCENARIOS !== '1') {
    const reason =
      'terminal-fence-restart needs --slot <farmslot-farm slotId> and FARMSLOT_ENABLE_SCRIPTED_SCENARIOS=1; it dispatches real scripted validation runs and restarts the gateway';
    const report = { runner: reportRunner, pass: false, skipped: !explicit, reason, nodes: [] };
    const outPath = writeEvidence(report, SCENARIO_ID, reportRunner, outDir);
    return { scenario: SCENARIO_ID, runner: reportRunner, outPath, pass: false, report };
  }

  const nodes = [];
  const node = (name, pass, detail) => {
    nodes.push({ name, pass, detail });
    if (!pass) throw new Error(`${name}: ${detail}`);
  };
  const report = {
    runner: reportRunner,
    slotId,
    pass: false,
    restartKind:
      'dev tsx-watch supervisor restart triggered by touching a gateway source file, proven by the listening PID changing — NOT a `farmslot up` restart',
    nodes,
  };
  const createdRunIds = [];

  try {
    const fleet = rpc('fleet.status');
    const slot = fleet.fleet?.slots?.find((candidate) => candidate.slot === slotId);
    if (!slot) throw new Error(`slot ${slotId} not found in fleet.status`);
    report.project = slot.project;

    // The restart replaces the whole gateway process, not one slot's worth of
    // it: every operator session on it dies. So the check has to be
    // gateway-WIDE, which is what it claims to be — checking only this slot
    // promised inactivity it had not looked for.
    //
    // A run parked at a gate is not a live proof: it holds no turn and its
    // record survives the restart. Anything actually executing is.
    const active = rpc('run.list', { active: true }).runs ?? [];
    const EXECUTING = new Set([
      'grading',
      'writing-task',
      'slot-finding',
      'preparing',
      'dispatching',
      'monitoring',
      'self-reviewing',
      'completing',
      'ci-watching',
    ]);
    const executing = active.filter((run) => EXECUTING.has(run.status));
    report.otherActiveRuns = active.map((run) => ({
      runId: run.id,
      status: run.status,
      slotId: run.slotId,
    }));
    node(
      'no-live-proof-on-this-gateway',
      executing.length === 0,
      executing.length === 0
        ? `no executing run on this gateway (${active.length} non-terminal run(s), none mid-turn)`
        : `executing run(s) that a restart would interrupt: ${executing
            .map(
              (run) => `${run.id.slice(0, 8)}/${run.status}${run.slotId ? `@${run.slotId}` : ''}`,
            )
            .join(', ')}`,
    );
    node(
      'target-slot-free',
      active.every((run) => run.slotId !== slotId),
      active.some((run) => run.slotId === slotId)
        ? `an active run already occupies ${slotId}`
        : `no active run occupies ${slotId}`,
    );

    const owner = createScriptedRun(slotId, slot.project, undefined);
    createdRunIds.push(owner.id);
    report.ownerRunId = owner.id;
    report.familyId = owner.familyId ?? null;
    await pollFor(
      'the owner run to bind its slot',
      () => rpc('run.get', { runId: owner.id }).run,
      (state) => state.slotId === slotId,
      timeoutMs,
    );

    const acquired = await acquireThroughPressure(
      slotId,
      owner.id,
      owner.familyId,
      Math.min(timeoutMs, 600_000),
    );
    node(
      'owner-acquires',
      acquired.ok === true,
      acquired.ok
        ? `${CAPABILITY_ID} lease ${acquired.lease?.id} reached ${acquired.lease?.state}`
        : `acquire refused: ${acquired.conflict?.reason ?? 'unknown'}`,
    );

    const terminal = rpc('runtime.posture.apply', {
      runId: owner.id,
      posture: 'terminal',
      operationId: `${SCENARIO_ID}-terminal-${process.pid}`,
    });
    report.terminalApply = { ok: terminal.ok, outcome: terminal.transition?.outcome };
    node(
      'terminal-cleanup-applied',
      terminal.ok === true,
      `terminal posture outcome ${terminal.transition?.outcome}`,
    );

    // A family sibling, which is what the fence has to refuse: the whole family
    // is what terminal cleanup covers.
    const sibling = createScriptedRun(slotId, slot.project, owner.familyId);
    createdRunIds.push(sibling.id);
    report.siblingRunId = sibling.id;

    const refusedBefore = acquire(slotId, sibling.id, owner.familyId);
    report.refusedBeforeRestart = {
      ok: refusedBefore.ok,
      reason: refusedBefore.conflict?.reason ?? null,
    };
    node(
      'sibling-refused-before-restart',
      refusedBefore.ok === false &&
        /terminal capability cleanup/.test(refusedBefore.conflict?.reason ?? ''),
      `acquire ok=${refusedBefore.ok} reason=${refusedBefore.conflict?.reason ?? 'none'}`,
    );

    const restart = await restartGateway(Math.min(timeoutMs, 180_000));
    report.restart = restart;
    node(
      'gateway-process-replaced',
      restart.after !== restart.before,
      `listener pid ${restart.before} -> ${restart.after} on port ${gatewayPort()}`,
    );

    // THE claim: a brand new process, whose in-memory fence started empty.
    const refusedAfter = acquire(slotId, sibling.id, owner.familyId);
    report.refusedAfterRestart = {
      ok: refusedAfter.ok,
      reason: refusedAfter.conflict?.reason ?? null,
    };
    node(
      'sibling-refused-after-restart',
      refusedAfter.ok === false &&
        /terminal capability cleanup/.test(refusedAfter.conflict?.reason ?? ''),
      `acquire ok=${refusedAfter.ok} reason=${refusedAfter.conflict?.reason ?? 'none'}`,
    );

    // And the fence is not a blanket refusal: an unrelated run still gets the
    // provider, so the slot is not bricked by one terminal family.
    const fresh = createScriptedRun(slotId, slot.project, undefined);
    createdRunIds.push(fresh.id);
    report.freshRunId = fresh.id;
    const freshAcquire = await acquireThroughPressure(
      slotId,
      fresh.id,
      fresh.familyId,
      Math.min(timeoutMs, 600_000),
    );
    report.freshAcquire = { ok: freshAcquire.ok, reason: freshAcquire.conflict?.reason ?? null };
    node(
      'fresh-run-still-acquires',
      freshAcquire.ok === true,
      freshAcquire.ok
        ? `${CAPABILITY_ID} lease ${freshAcquire.lease?.id} reached ${freshAcquire.lease?.state}`
        : `acquire refused: ${freshAcquire.conflict?.reason ?? 'unknown'}`,
    );

    report.pass = nodes.every((entry) => entry.pass);
  } catch (error) {
    report.error = error?.message ?? String(error);
    report.pass = false;
  } finally {
    for (const runId of createdRunIds) {
      const cancelled = tryRpc('run.cancel', {
        runId,
        reason: `${SCENARIO_ID} validation complete`,
      });
      if (!cancelled.ok)
        report.cleanupWarnings = [...(report.cleanupWarnings ?? []), cancelled.error];
    }
    const released = tryRpc('slot.release', { slotId, keepWork: true }, 300_000);
    if (!released.ok) {
      report.cleanupWarnings = [...(report.cleanupWarnings ?? []), released.error];
    }
  }

  const outPath = writeEvidence(report, SCENARIO_ID, reportRunner, outDir);
  return { scenario: SCENARIO_ID, runner: reportRunner, outPath, pass: report.pass, report };
}
