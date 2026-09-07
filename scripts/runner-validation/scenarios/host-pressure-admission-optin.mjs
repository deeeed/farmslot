import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import { ROOT } from '../lib/common.mjs';
import { writeEvidence } from '../lib/evidence.mjs';

export const SCENARIO_ID = 'host-pressure-admission-optin';
export const RUNNER_AGNOSTIC = true;

/**
 * Live proof that host-pressure capability admission is OPT-IN, through the
 * production gateway.
 *
 * A real scripted run acquires a medium-cost capability on a machine that is
 * genuinely over the critical load threshold. With no
 * `runtime_capabilities.host_pressure_admission` block — the default — the
 * acquire must SUCCEED, and the pressure must still be reported: the granted
 * lease carries a `host-pressure-advisory`, a type distinct from the
 * `host-pressure` conflict a refusal uses, and `runtime.capability.status`
 * surfaces it as `pressure`.
 *
 * Every assertion is a gateway RPC read — the acquire result, the lease record,
 * the derived status pressure, and the machine's own pressure snapshot — never
 * pane text.
 *
 * Capability choice: `recording` on `farmslot-farm`. It is medium-cost, so the
 * gate applies to it, and its acquire/release are cheap slot actions rather
 * than a device or browser boot.
 *
 * The enforcing modes need the gateway configured for them before the run, so
 * the operator declares which opt-in path they set up with `--via`:
 *
 *   --expect off    --via default   no project block, no env override
 *   --expect refuse --via project   the project's own host_pressure_admission
 *                                   block, with NO env override set
 *   --expect refuse --via env       FARMSLOT_HOST_PRESSURE_ADMISSION on the
 *                                   gateway process
 *
 * `--via project` is the one that proves the project config actually reaches
 * the admission decision; an env-override proof cannot stand in for it, because
 * the env path bypasses project config entirely.
 */
const CAPABILITY_ID = 'recording';

/** How long to wait for the host to read critical before giving up. */
const PRESSURE_WINDOW_TIMEOUT_MS = 180_000;
/** Acquire attempts, for when a load spike recedes between two reads. */
const MAX_ACQUIRE_ATTEMPTS = 6;

async function poll(description, read, accept, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    latest = read();
    if (accept(latest)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  throw new Error(`Timed out waiting for ${description}; latest=${JSON.stringify(latest)}`);
}

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

/** Host load per core, the number the critical threshold is expressed in. */
function loadPerCore() {
  const cores = os.cpus().length || 1;
  const [load1] = os.loadavg();
  return { cores, load1, perCore: Number((load1 / cores).toFixed(2)) };
}

export async function runScenario({
  outDir,
  slotId,
  explicit = false,
  expect = 'off',
  via = expect === 'off' ? 'default' : 'project',
}) {
  const reportRunner = 'scripted';
  if (!['default', 'project', 'env'].includes(via)) {
    throw new Error(`--via must be default, project or env, got '${via}'`);
  }
  // One evidence file per mode AND opt-in path: `refuse` proven through project
  // config and `refuse` proven through the env override are different claims
  // and must not overwrite each other.
  const evidenceId = `${SCENARIO_ID}-${expect}-${via}`;
  if (!slotId || process.env.FARMSLOT_ENABLE_SCRIPTED_SCENARIOS !== '1') {
    const requirement =
      'host-pressure-admission-optin needs --slot <farmslot-farm slotId> and FARMSLOT_ENABLE_SCRIPTED_SCENARIOS=1; it dispatches a real scripted validation run';
    const report = explicit
      ? { runner: reportRunner, pass: false, error: requirement }
      : { runner: reportRunner, skipped: true, skipReason: requirement, pass: true };
    const outPath = writeEvidence(report, evidenceId, reportRunner, outDir);
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
    expectedMode: expect,
    // WHICH opt-in path this run exercised, declared by the operator who
    // configured the gateway. `project` is the one that proves the project
    // config path actually reaches the admission decision; `env` proves only
    // the override. They are not interchangeable evidence.
    optInPath: via,
    gatewayConfiguration: {
      default: 'no project host_pressure_admission block and no FARMSLOT_HOST_PRESSURE_ADMISSION',
      project: `projects/<project>/project.json runtime_capabilities.host_pressure_admission.mode = ${expect}, with NO env override set`,
      env: `FARMSLOT_HOST_PRESSURE_ADMISSION=${expect} on the gateway process`,
    }[via],
    hostLoad: loadPerCore(),
    // Set when an operator deliberately loaded the host to reach the critical
    // threshold, so the evidence never implies the spike was organic.
    loadNote: process.env.FARMSLOT_VALIDATION_LOAD_NOTE ?? null,
    rerunCommand: `FARMSLOT_ENABLE_SCRIPTED_SCENARIOS=1 FARMSLOT_GATEWAY=ws://localhost:7801 node scripts/runner-validation/run.mjs --scenario ${SCENARIO_ID} --slot ${slotId} --expect ${expect} --via ${via}`,
    slotId,
    runId: null,
    nodes: {
      machinePressure: null,
      acquire: null,
      statusPressure: null,
      released: null,
      advisoryClearedAfterRelease: null,
      noLeftoverLeases: null,
    },
    pass: false,
  };
  const runIds = [];

  try {
    const fleet = rpc('fleet.status', {});
    const slot = (fleet.fleet?.slots ?? []).find((candidate) => candidate.slot === slotId);
    if (!slot) throw new Error(`slot ${slotId} not found in fleet.status`);

    // 1. The machine really is over the critical threshold. Without this the
    //    rest of the scenario proves nothing: an acquire on a calm machine
    //    succeeds in every mode. Load moves under us, so wait for a critical
    //    reading rather than failing on the first calm sample.
    const readMachinePressure = () => {
      const pressure = rpc('resource.pressure.snapshot', { machines: [slot.machine] });
      const machine = (pressure.machines ?? []).find((entry) => entry.machine === slot.machine);
      return {
        machine: slot.machine,
        severity: machine?.severity ?? null,
        concerns: (machine?.concerns ?? []).map((concern) => concern.reason),
      };
    };
    report.nodes.machinePressure = await poll(
      `machine ${slot.machine} to read critical`,
      readMachinePressure,
      (reading) => reading.severity === 'critical',
      PRESSURE_WINDOW_TIMEOUT_MS,
    );

    // 2. A real scripted run to own the lease.
    const created = rpc('run.create', {
      project: slot.project,
      flowType: 'dev',
      mode: 'interactive',
      ticketOrPr: 'DEV-PRESSURE-ADMISSION-OPTIN',
      initialContext: 'Host-pressure admission opt-in validation. Makes no changes.',
      runner: 'scripted',
      scripted: { mode: 'scenario', scenario: 'success', stepDelayMs: 600_000 },
      slotId,
      skipPrepare: true,
    });
    report.runId = created.run.id;
    runIds.push(created.run.id);

    // 3. The acquire itself, under critical pressure.
    //
    // The gateway reads pressure again inside the acquire, so a load spike that
    // has receded between step 1 and here produces a granted lease with no
    // advisory — a missed window, not a broken contract. Retry until the two
    // reads line up, releasing anything a missed attempt granted so the
    // scenario never stacks leases.
    const attemptAcquire = () =>
      rpc('runtime.capability.acquire', {
        slotId,
        capabilityId: CAPABILITY_ID,
        ownerRunId: created.run.id,
        proofRequirement: {
          capabilityId: CAPABILITY_ID,
          reason: 'host-pressure admission opt-in validation',
          mode: 'state',
        },
      });
    let acquire = attemptAcquire();
    report.attempts = 1;
    while (
      expect === 'off' &&
      acquire.ok &&
      acquire.lease.pressure?.kind !== 'host-pressure-advisory' &&
      report.attempts < MAX_ACQUIRE_ATTEMPTS
    ) {
      rpc('runtime.capability.release', {
        slotId,
        ownerRunId: created.run.id,
        capabilityId: CAPABILITY_ID,
        keepWarm: false,
      });
      await new Promise((resolve) => setTimeout(resolve, 5000));
      report.nodes.machinePressure = readMachinePressure();
      acquire = attemptAcquire();
      report.attempts += 1;
    }
    report.nodes.acquire = {
      ok: acquire.ok,
      leaseState: acquire.ok ? acquire.lease.state : null,
      leasePressure: acquire.ok ? (acquire.lease.pressure ?? null) : null,
      conflict: acquire.ok ? null : acquire.conflict,
    };

    if (expect === 'off') {
      if (!acquire.ok) {
        throw new Error(
          `the gate is off but the acquire was refused: ${JSON.stringify(acquire.conflict)}`,
        );
      }
      if (acquire.lease.pressure?.kind !== 'host-pressure-advisory') {
        throw new Error(
          `after ${report.attempts} attempt(s) the granted lease still carries no host-pressure-advisory (${JSON.stringify(acquire.lease.pressure ?? null)}); the host calmed below the critical threshold between the snapshot and the acquire — re-run while the machine is loaded`,
        );
      }
      // The advisory must NOT be shaped like a refusal: a client matching the
      // conflict kind has to miss it, and it must say when it was read.
      if (!acquire.lease.pressure.observedAt || 'queued' in acquire.lease.pressure) {
        throw new Error(
          `the advisory is shaped like a refusal: ${JSON.stringify(acquire.lease.pressure)}`,
        );
      }
      const status = rpc('runtime.capability.status', { slotId, ownerRunId: created.run.id });
      report.nodes.statusPressure = status.pressure ?? null;
      if (status.pressure?.kind !== 'host-pressure-advisory') {
        throw new Error(
          `runtime.capability.status does not report the pressure as advisory: ${JSON.stringify(status.pressure ?? null)}`,
        );
      }
      const release = rpc('runtime.capability.release', {
        slotId,
        ownerRunId: created.run.id,
        capabilityId: CAPABILITY_ID,
        keepWarm: false,
      });
      report.nodes.released = { ok: release.ok, failures: release.failures };
      if (!release.ok) throw new Error(`release failed: ${JSON.stringify(release.failures)}`);

      // The advisory describes a live lease. Once that lease is released the
      // slot must stop reporting it, or a dead reading outlives the acquire it
      // belonged to and every later reader sees stale pressure.
      const afterRelease = rpc('runtime.capability.status', { slotId });
      report.nodes.advisoryClearedAfterRelease = afterRelease.pressure ?? null;
      if (afterRelease.pressure) {
        throw new Error(
          `the released lease's advisory is still reported on the slot: ${JSON.stringify(afterRelease.pressure)}`,
        );
      }
    } else {
      if (acquire.ok) {
        throw new Error(
          `mode ${expect} was expected to refuse this acquire, but it was granted (lease ${acquire.lease.id})`,
        );
      }
      if (acquire.conflict?.kind !== 'host-pressure') {
        throw new Error(
          `expected a host-pressure refusal, got ${JSON.stringify(acquire.conflict)}`,
        );
      }
      if (acquire.conflict.kind === 'host-pressure-advisory') {
        throw new Error('an advisory reached the refusal path, which it must never be able to do');
      }
      if (expect === 'queue' && acquire.conflict.queued !== true) {
        throw new Error('queue mode refused without queueing the caller');
      }
    }

    for (const runId of runIds) {
      rpc('run.cancel', { runId, reason: `${SCENARIO_ID} cleanup` });
    }
    rpc('run.bulkDelete', { runIds: [...runIds] });
    runIds.length = 0;

    const leftover = rpc('runtime.capability.status', { slotId })
      .leases.filter((lease) => lease.state !== 'released')
      .map((lease) => ({ id: lease.id, capabilityId: lease.capabilityId, state: lease.state }));
    report.nodes.noLeftoverLeases = leftover;
    if (leftover.length > 0) {
      throw new Error(`leases survived cleanup: ${JSON.stringify(leftover)}`);
    }

    report.pass = true;
  } catch (error) {
    report.pass = false;
    report.error = error?.message || String(error);
    report.hostLoadAtFailure = loadPerCore();
  } finally {
    // Cleanup, not an assertion: a failure mid-scenario must not leave a
    // scripted run holding a slot.
    for (const runId of runIds) {
      try {
        rpc('run.cancel', { runId, reason: `${SCENARIO_ID} cleanup` });
        rpc('run.bulkDelete', { runIds: [runId] });
      } catch (error) {
        report.cleanupErrors = [
          ...(report.cleanupErrors ?? []),
          `cleanup ${runId}: ${error?.message || String(error)}`,
        ];
      }
    }
  }

  const outPath = writeEvidence(report, evidenceId, reportRunner, outDir);
  return { scenario: SCENARIO_ID, runner: reportRunner, outPath, pass: report.pass, report };
}
