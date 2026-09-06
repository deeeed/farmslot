import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import { ROOT } from '../lib/common.mjs';
import { writeEvidence } from '../lib/evidence.mjs';

export const SCENARIO_ID = 'fleet-device-contention';
export const RUNNER_AGNOSTIC = true;

/**
 * Live proof of fleet-scoped resource claims with a wait queue, through the
 * production gateway.
 *
 * Two real scripted runs on two different slots contend for ONE fleet-scoped
 * claim. The first acquires it; the second asks to queue and is told where it
 * stands; the first releases; the second is drained to `acquired` without ever
 * re-asking. Every assertion is a gateway RPC read — lease records, lifecycle
 * events, the derived claim queue, and the run's own persisted posture — never
 * pane text.
 *
 * Capability choice: `recording` on `farmslot-farm`, whose `capture-helper`
 * claim is declared `fleet`. No slot in this pool configures an `android-device`
 * resource, so the `android-device` provider is unavailable everywhere and the
 * device the item was written around cannot be contended for live. `recording`
 * is the closest real thing: exclusive, fleet-scoped, no keep-warm window, and
 * its acquire and release are cheap slot actions rather than a device boot.
 *
 * NOT covered live, deliberately:
 * - The work-graph `waitingOn.kind: 'resource'` projection. That needs a run
 *   that IS a graph node; these are ad-hoc validation runs with no backlog item,
 *   and manufacturing a graph node here would write real backlog state. The run
 *   half of it — the durable `resourceWait` the projection reads — IS asserted
 *   here from `runtime.posture.status`. The projection itself is covered in
 *   `services/gateway/src/work-graph/store.test.ts`.
 * - `android-device` at fleet scope, for the reason above. It stays a
 *   config-only example in `projects/farmslot-farm/project.json`.
 */
const CAPABILITY_ID = 'recording';
const CLAIM_ID = 'capture-helper';

/** The queue drain hands the provider boot to a background resume; give it room. */
const DRAIN_TIMEOUT_MS = 120_000;

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
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Timed out waiting for ${description}; latest=${JSON.stringify(latest)}`);
}

/** Host load per core, the number gateway admission actually gates on. */
function loadPerCore() {
  const cores = os.cpus().length || 1;
  const [load1] = os.loadavg();
  return { cores, load1, perCore: Number((load1 / cores).toFixed(2)) };
}

/**
 * A second farmslot-farm slot to contend from.
 *
 * Same machine as the first on purpose: it keeps the two slots' claims
 * comparable at every scope, so a `fleet` result here is not quietly a `machine`
 * result. An idle slot only — taking a busy one would fight a real run.
 */
function pickSecondSlot(fleet, firstSlotId) {
  const slots = fleet.fleet?.slots ?? [];
  const first = slots.find((slot) => slot.slot === firstSlotId);
  if (!first) throw new Error(`slot ${firstSlotId} not found in fleet.status`);
  const candidate = slots.find(
    (slot) =>
      slot.slot !== firstSlotId &&
      slot.project === first.project &&
      slot.machine === first.machine &&
      (slot.status === 'free' || slot.status === 'idle' || !slot.currentRunId),
  );
  if (!candidate) {
    throw new Error(
      `no second idle ${first.project} slot on ${first.machine} to contend from; ` +
        `candidates=${JSON.stringify(slots.map((slot) => ({ slot: slot.slot, project: slot.project, machine: slot.machine, status: slot.status })))}`,
    );
  }
  return { first, second: candidate };
}

function createRun(slot, note) {
  const created = rpc('run.create', {
    project: slot.project,
    flowType: 'dev',
    mode: 'interactive',
    ticketOrPr: 'fleet device contention validation',
    initialContext: `${note} Makes no changes.`,
    runner: 'scripted',
    scripted: { mode: 'scenario', scenario: 'success', stepDelayMs: 2000 },
    slotId: slot.slot,
    skipPrepare: true,
  });
  return created.run;
}

function leaseFor(slotId, runId, capabilityId) {
  const status = rpc('runtime.capability.status', { slotId, ownerRunId: runId });
  return status.leases.find((lease) => lease.capabilityId === capabilityId) ?? null;
}

/** Every live lease left on a slot, which after cancellation must be none. */
function liveLeases(slotId) {
  return rpc('runtime.capability.status', { slotId })
    .leases.filter((lease) => lease.state !== 'released')
    .map((lease) => ({ id: lease.id, capabilityId: lease.capabilityId, state: lease.state }));
}

export async function runScenario({ timeoutMs, outDir, slotId, explicit = false }) {
  const reportRunner = 'scripted';
  if (!slotId || process.env.FARMSLOT_ENABLE_SCRIPTED_SCENARIOS !== '1') {
    const requirement =
      'fleet-device-contention needs --slot <farmslot-farm slotId> and FARMSLOT_ENABLE_SCRIPTED_SCENARIOS=1; it dispatches two real scripted validation runs on two slots';
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
    capabilityId: CAPABILITY_ID,
    claimId: CLAIM_ID,
    hostLoad: loadPerCore(),
    rerunCommand: `FARMSLOT_ENABLE_SCRIPTED_SCENARIOS=1 FARMSLOT_GATEWAY=ws://localhost:7801 node scripts/runner-validation/run.mjs --scenario ${SCENARIO_ID} --slot ${slotId}`,
    holderSlotId: slotId,
    waiterSlotId: null,
    holderRunId: null,
    waiterRunId: null,
    nodes: {
      holderAcquired: null,
      waiterQueued: null,
      queueVisible: null,
      runResourceWait: null,
      drained: null,
      waiterReleased: null,
      noLeftoverLeases: null,
    },
    blockedByAdmission: false,
    notCoveredLive: [
      'work-graph waitingOn.kind=resource projection (needs a graph-node run; unit-covered in services/gateway/src/work-graph/store.test.ts)',
      'android-device at fleet scope (no pool slot configures an android-device resource, so the provider is unavailable fleet-wide)',
    ],
    pass: false,
    error: null,
  };
  const runIds = [];

  try {
    const fleet = rpc('fleet.status');
    const { first, second } = pickSecondSlot(fleet, slotId);
    if (first.project !== 'farmslot-farm') {
      throw new Error(`slot ${slotId} runs project ${first.project}; expected farmslot-farm`);
    }
    report.waiterSlotId = second.slot;

    // The claim must really be declared `fleet` in the live catalog, or the rest
    // of this scenario proves nothing about scope.
    const catalog = rpc('runtime.capability.list', { slotId });
    const entry = (catalog.capabilities ?? []).find((item) => item.id === CAPABILITY_ID);
    if (!entry) throw new Error(`${CAPABILITY_ID} is not in the ${first.project} catalog`);
    const claim = entry.cost.resources.find((resource) => resource.id === CLAIM_ID);
    report.declaredClaim = claim ?? null;
    if (claim?.scope !== 'fleet') {
      throw new Error(
        `${CAPABILITY_ID} claim '${CLAIM_ID}' is scoped ${claim?.scope ?? 'unset'}, expected fleet`,
      );
    }
    if (entry.availability.state !== 'available') {
      throw new Error(`${CAPABILITY_ID} is unavailable on ${slotId}: ${entry.availability.reason}`);
    }

    const holder = createRun(first, 'Fleet contention holder.');
    runIds.push(holder.id);
    report.holderRunId = holder.id;
    const waiter = createRun(second, 'Fleet contention waiter.');
    runIds.push(waiter.id);
    report.waiterRunId = waiter.id;
    for (const [runId, boundSlot] of [
      [holder.id, first.slot],
      [waiter.id, second.slot],
    ]) {
      await poll(
        `run ${runId} to bind ${boundSlot}`,
        () => rpc('run.get', { runId }).run,
        (state) => state.slotId === boundSlot,
        timeoutMs,
      );
    }

    // 1. The holder takes the fleet-scoped claim, and the LEASE records it.
    const acquired = rpc('runtime.capability.acquire', {
      slotId: first.slot,
      capabilityId: CAPABILITY_ID,
      ownerRunId: holder.id,
      proofRequirement: {
        capabilityId: CAPABILITY_ID,
        reason: 'fleet-scoped claim contention validation',
        mode: 'state',
      },
    });
    if (!acquired.ok) {
      // Admission sheds medium-cost acquires above the load threshold. That is
      // the gateway working as designed, not a defect in the queue — so it is
      // recorded as a blocked run with the load that blocked it, never as a pass.
      report.blockedByAdmission = acquired.conflict?.kind === 'host-pressure';
      throw new Error(
        `holder acquire refused (${acquired.conflict?.kind}): ${acquired.conflict?.reason}`,
      );
    }
    report.nodes.holderAcquired = {
      leaseId: acquired.lease.id,
      state: acquired.lease.state,
      machine: acquired.lease.machine ?? null,
      claims: acquired.lease.claims ?? null,
    };
    const holderClaim = (acquired.lease.claims ?? []).find((item) => item.id === CLAIM_ID);
    if (holderClaim?.scope !== 'fleet') {
      throw new Error(`holder lease did not persist a fleet-scoped '${CLAIM_ID}' claim`);
    }
    if (!acquired.lease.machine) {
      throw new Error('holder lease did not persist the machine it was taken on');
    }

    // 2. The waiter, on ANOTHER slot, asks to queue rather than be refused.
    const queued = rpc('runtime.capability.acquire', {
      slotId: second.slot,
      capabilityId: CAPABILITY_ID,
      ownerRunId: waiter.id,
      proofRequirement: {
        capabilityId: CAPABILITY_ID,
        reason: 'fleet-scoped claim contention validation',
        mode: 'state',
      },
      queueOnConflict: true,
    });
    if (queued.ok) {
      throw new Error(
        'the second slot acquired a fleet-scoped exclusive claim the first slot holds',
      );
    }
    report.nodes.waiterQueued = queued.conflict;
    if (queued.conflict.kind !== 'scoped-wait') {
      report.blockedByAdmission = queued.conflict.kind === 'host-pressure';
      throw new Error(
        `waiter got ${queued.conflict.kind} instead of scoped-wait: ${queued.conflict.reason}`,
      );
    }
    if (queued.conflict.claimId !== CLAIM_ID || queued.conflict.scope !== 'fleet') {
      throw new Error(`scoped-wait named ${queued.conflict.claimId}/${queued.conflict.scope}`);
    }
    if (queued.conflict.owner.runId !== holder.id) {
      throw new Error(`scoped-wait named ${queued.conflict.owner.runId} as the holder`);
    }
    if (queued.conflict.position !== 1) {
      throw new Error(`scoped-wait reported position ${queued.conflict.position}, expected 1`);
    }

    // 3. The queue is readable, with the blocking owner from the other slot.
    const waiterStatus = rpc('runtime.capability.status', { slotId: second.slot });
    const queuedLease = waiterStatus.leases.find(
      (lease) => lease.id === queued.conflict.queuedLeaseId,
    );
    const waiterRow = (waiterStatus.claimWaiters ?? []).find(
      (row) => row.leaseId === queued.conflict.queuedLeaseId,
    );
    report.nodes.queueVisible = {
      leaseState: queuedLease?.state ?? null,
      wait: queuedLease?.wait ?? null,
      claimWaiters: waiterStatus.claimWaiters ?? null,
    };
    if (queuedLease?.state !== 'queued') {
      throw new Error(`queued lease reads ${queuedLease?.state}, expected queued`);
    }
    if (queuedLease.wait?.blockingOwner?.runId !== holder.id) {
      throw new Error('the queued lease does not carry the blocking owner from the other slot');
    }
    if (waiterRow?.position !== 1 || waiterRow.blockingOwner.runId !== holder.id) {
      throw new Error(`claimWaiters did not place the waiter first behind ${holder.id}`);
    }

    // 4. The wait is durable ON THE RUN, which is what a client reads back.
    const blockedPosture = rpc('runtime.posture.apply', {
      runId: waiter.id,
      posture: 'active',
      operationId: `${SCENARIO_ID}-wait-${process.pid}`,
      proofRequirements: [
        { capabilityId: CAPABILITY_ID, reason: 'contention validation', mode: 'state' },
      ],
    });
    const postureStatus = rpc('runtime.posture.status', { runId: waiter.id });
    report.nodes.runResourceWait = {
      applyOk: blockedPosture.ok,
      outcome: blockedPosture.transition.outcome,
      rejectionKind: blockedPosture.transition.rejection?.kind ?? null,
      conflictKind: blockedPosture.transition.rejection?.conflict?.kind ?? null,
      resourceWait: postureStatus.state.resourceWait ?? null,
    };
    const wait = postureStatus.state.resourceWait;
    if (!wait || wait.claimId !== CLAIM_ID || wait.blockingOwner.runId !== holder.id) {
      throw new Error(
        `the waiter run does not carry a durable resource wait: ${JSON.stringify(wait)}`,
      );
    }

    // 5. The holder releases and the queue drains — without the waiter asking again.
    const eventsBefore = rpc('runtime.capability.status', { slotId: second.slot }).events.length;
    const released = rpc('runtime.capability.release', {
      slotId: first.slot,
      ownerRunId: holder.id,
      capabilityId: CAPABILITY_ID,
      keepWarm: false,
    });
    if (!released.ok)
      throw new Error(`holder release failed: ${JSON.stringify(released.failures)}`);
    const drainedLease = await poll(
      'the queued lease to reach acquired without a second acquire call',
      () => leaseFor(second.slot, waiter.id, CAPABILITY_ID),
      (lease) => lease?.state === 'acquired' || lease?.state === 'error',
      DRAIN_TIMEOUT_MS,
    );
    const afterEvents = rpc('runtime.capability.status', { slotId: second.slot }).events;
    const promotion = afterEvents
      .slice(eventsBefore)
      .find((event) => event.kind === 'acquiring' && event.owner?.runId === waiter.id);
    report.nodes.drained = {
      leaseId: drainedLease?.id ?? null,
      state: drainedLease?.state ?? null,
      wait: drainedLease?.wait ?? null,
      promotionEvent: promotion ?? null,
      holderReleaseEffects: released.effects,
    };
    if (drainedLease?.state !== 'acquired') {
      throw new Error(`the drained lease reads ${drainedLease?.state}, expected acquired`);
    }
    if (drainedLease.id !== queued.conflict.queuedLeaseId) {
      throw new Error('the waiter acquired a NEW lease instead of the queue place it held');
    }
    if (!promotion) {
      throw new Error('no acquiring event was emitted for the waiter when the claim freed');
    }

    // 6. The waiter gives it back, and nothing is left holding anything.
    const waiterRelease = rpc('runtime.capability.release', {
      slotId: second.slot,
      ownerRunId: waiter.id,
      capabilityId: CAPABILITY_ID,
      keepWarm: false,
    });
    report.nodes.waiterReleased = {
      ok: waiterRelease.ok,
      released: waiterRelease.released.map((lease) => lease.capabilityId),
    };
    if (!waiterRelease.ok) {
      throw new Error(`waiter release failed: ${JSON.stringify(waiterRelease.failures)}`);
    }

    for (const runId of runIds) rpc('run.cancel', { runId, reason: `${SCENARIO_ID} cleanup` });
    runIds.length = 0;
    const leftover = {
      [first.slot]: liveLeases(first.slot),
      [second.slot]: liveLeases(second.slot),
    };
    report.nodes.noLeftoverLeases = leftover;
    const stillHeld = Object.values(leftover).flat();
    if (stillHeld.length > 0) {
      throw new Error(`leases survived cancellation: ${JSON.stringify(stillHeld)}`);
    }

    report.pass = true;
  } catch (error) {
    report.pass = false;
    report.error = error?.message || String(error);
    report.hostLoadAtFailure = loadPerCore();
  } finally {
    // Cancellation is cleanup, not an assertion: a failure mid-scenario must not
    // leave two scripted runs holding slots.
    for (const runId of runIds) {
      try {
        rpc('run.cancel', { runId, reason: `${SCENARIO_ID} cleanup` });
      } catch (error) {
        report.cleanupErrors = [
          ...(report.cleanupErrors ?? []),
          `run.cancel ${runId}: ${error?.message || String(error)}`,
        ];
      }
    }
  }

  const outPath = writeEvidence(report, SCENARIO_ID, reportRunner, outDir);
  return { scenario: SCENARIO_ID, runner: reportRunner, outPath, pass: report.pass, report };
}
