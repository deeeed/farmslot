#!/usr/bin/env node
/**
 * MANUAL-000113 live scenario: re-target a capability lease at another device
 * through the production dev gateway (ws://localhost:7801).
 *
 * Every assertion reads a structured signal — `xcrun simctl list -j devices`
 * for device state, gateway RPC results for lease state. No pane text.
 *
 * The re-target is driven through the two paths an operator actually uses, not
 * through raw acquire/release: `runtime.posture.apply` (the reconciler path
 * `recipe.rerun` delegates to) and `recipe.rerun` with a `target` (which adds
 * the proof-plan rewrite). Both need a real run bound to the slot — set
 * SMOKE_RUN_ID to a live, non-terminal run whose slot is SMOKE_SLOT.
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';

const run = promisify(execFile);
const GW = 'ws://localhost:7801';
const HOME = '/Users/deeeed/.farmslot-dev';
const ROOT = '/Users/deeeed/dev/farmslot';
const CDP = `${ROOT}/apps/command-center/scripts/cdp.mjs`;
const EVIDENCE_PATH = `${ROOT}/docs/operations/evidence/runner-validate-macwork-gateway-device-retarget-smoke.json`;

const nodes = [];

async function gateway(method, params) {
  const args = [CDP, 'gateway', method];
  if (params !== undefined) args.push(JSON.stringify(params));
  const { stdout } = await run('node', args, {
    cwd: ROOT,
    env: { ...process.env, FARMSLOT_HOME: HOME, FARMSLOT_GATEWAY: GW },
    maxBuffer: 32 * 1024 * 1024,
    timeout: 600_000,
  });
  return JSON.parse(stdout);
}

async function simctl() {
  const { stdout } = await run('xcrun', ['simctl', 'list', '-j', 'devices'], {
    maxBuffer: 32 * 1024 * 1024,
    timeout: 180_000,
  });
  const parsed = JSON.parse(stdout);
  const byName = {};
  for (const devices of Object.values(parsed.devices)) {
    for (const device of devices) {
      if (device.isAvailable) byName[device.name] = { udid: device.udid, state: device.state };
    }
  }
  return byName;
}

function node(name, claim, ok, evidence) {
  nodes.push({ node: name, claim, ok, evidence });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} — ${claim}`);
  if (!ok) console.log(JSON.stringify(evidence, null, 2));
  return ok;
}

const SLOT = process.env.SMOKE_SLOT ?? 'macwork-ff-4';
const SIBLING = process.env.SMOKE_SIBLING ?? 'macwork-ff-1';
const OWN_SIM = process.env.SMOKE_OWN_SIM ?? 'fs-4';
const OTHER_SIM = process.env.SMOKE_OTHER_SIM ?? 'playground-1';
/**
 * The lease owner. `runtime.posture.apply` and `recipe.rerun` both need a REAL
 * run record, so those two nodes record `not-exercised` and fail when this is a
 * synthetic id rather than reporting a pass they did not earn.
 */
const OWNER = process.env.SMOKE_RUN_ID ?? `smoke-113-${process.pid}`;
const HAS_REAL_RUN = Boolean(process.env.SMOKE_RUN_ID);
const SIBLING_OWNER = `smoke-113-sibling-${process.pid}`;

function requirement(parameters) {
  return {
    capabilityId: 'ios-simulator',
    reason: 'MANUAL-000113 device re-target smoke',
    mode: 'state',
    ...(parameters ? { parameters } : {}),
  };
}

async function acquire(slotId, ownerRunId, parameters) {
  return gateway('runtime.capability.acquire', {
    slotId,
    capabilityId: 'ios-simulator',
    ownerRunId,
    proofRequirement: requirement(parameters),
    ...(parameters ? { parameters } : {}),
  });
}

async function release(slotId, ownerRunId) {
  return gateway('runtime.capability.release', { slotId, ownerRunId });
}

function leaseSummary(status) {
  return (status.leases ?? []).map((lease) => ({
    capabilityId: lease.capabilityId,
    state: lease.state,
    parameters: lease.parameters,
    owner: lease.owner,
  }));
}

/** Why a node did not pass, read off the evidence it recorded. */
function blockedReason(entry) {
  const text = JSON.stringify(entry.evidence ?? {});
  if (text.includes('not-exercised')) return 'precondition';
  if (text.includes('host-pressure') || /above 1\.5x/.test(text)) return 'host-admission';
  return 'failure';
}

/**
 * The one place this driver writes its artifact, used by a clean finish and by
 * the catch alike.
 *
 * `blocked` is derived from THIS run: every node that did not pass, with the
 * reason read from what that node actually recorded. `ok` is exactly "nothing
 * is blocked" — there is no second condition, and no verdict is carried over
 * from a previous run.
 *
 * What IS carried over is evidence this driver cannot produce: the CDP probe
 * results and their negative proofs. Overwriting those on a rerun, or on a
 * thrown gateway call, would destroy the only record of the browser validation.
 */
function writeEvidence({ measured = {}, error } = {}) {
  const previous = existsSync(EVIDENCE_PATH) ? JSON.parse(readFileSync(EVIDENCE_PATH, 'utf8')) : {};
  const capturedAt = new Date().toISOString();
  const blockedNodes = nodes.filter((entry) => !entry.ok);
  // Setup guidance, not a verdict: how to rerun does not change with the
  // outcome, and a throw must not drop it either.
  const rerunEnv = previous.blocked?.rerunEnv ?? previous.rerunEnv;
  const reasons = [...new Set(blockedNodes.map(blockedReason))];
  const artifact = {
    item: 'MANUAL-000113',
    scenario: 're-target validation to another device',
    // Written from THIS run. The previous value described a scratchpad pass and
    // would have become false the moment the driver actually ran.
    producedBy: {
      script: 'scripts/runner-validation/gateway/device-retarget-smoke-driver.mjs',
      capturedAt,
      gateway: GW,
      slot: SLOT,
      siblingSlot: SIBLING,
      runId: HAS_REAL_RUN ? OWNER : null,
    },
    // Evidence from another producer, never this driver's to overwrite.
    ...(previous.cdp !== undefined ? { cdp: previous.cdp } : {}),
    ...(previous.negativeProof !== undefined ? { negativeProof: previous.negativeProof } : {}),
    ...(rerunEnv ? { rerunEnv } : {}),
    ownDevice: OWN_SIM,
    retargetDevice: OTHER_SIM,
    completedAt: capturedAt,
    hostLoad: hostLoad ?? previous.hostLoad,
    nodes,
    ok: blockedNodes.length === 0 && !error,
    ...(error ? { error } : {}),
    ...(blockedNodes.length > 0
      ? {
          blocked: {
            what: blockedNodes.map((entry) => entry.node),
            why: reasons
              .map((reason) =>
                reason === 'host-admission'
                  ? 'the gateway refused admission on host pressure, so no device could be booted'
                  : reason === 'precondition'
                    ? 'SMOKE_RUN_ID was not set, so the posture and recipe.rerun nodes had no run to drive'
                    : 'the node ran and did not hold',
              )
              .join('; '),
            rerunWith: 'scripts/runner-validation/gateway/device-retarget-smoke-driver.mjs',
            ...(rerunEnv ? { rerunEnv } : {}),
          },
        }
      : {}),
    ...measured,
  };
  writeFileSync(EVIDENCE_PATH, `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(`\nwrote ${EVIDENCE_PATH} — ok=${artifact.ok}`);
  process.exitCode = artifact.ok ? 0 : 1;
}

let hostLoad;

async function main() {
  const started = new Date().toISOString();
  hostLoad = (await run('uptime', [])).stdout.trim();

  // 0. Baseline.
  let sims = await simctl();
  node(
    'inventory-baseline',
    `the slot's configured simulator '${OWN_SIM}' and the re-target '${OTHER_SIM}' both exist`,
    Boolean(sims[OWN_SIM]) && Boolean(sims[OTHER_SIM]),
    { own: sims[OWN_SIM], other: sims[OTHER_SIM] },
  );

  // 1. Acquire with no parameters: the slot's own device.
  const plain = await acquire(SLOT, OWNER, undefined);
  sims = await simctl();
  node(
    'default-device-boots',
    `an acquire with no parameters boots the slot's own '${OWN_SIM}' and stores empty parameters`,
    plain.ok === true &&
      JSON.stringify(plain.lease?.parameters ?? {}) === '{}' &&
      sims[OWN_SIM]?.state === 'Booted',
    {
      acquire: plain.ok,
      parameters: plain.lease?.parameters,
      own: sims[OWN_SIM],
      conflict: plain.conflict,
    },
  );

  // 2. Re-target through the POSTURE RECONCILER, which is the path
  //    `recipe.rerun` delegates to (`prepareRunPostureForValidation`). The
  //    release of the old device and the acquire of the new one are the
  //    product's own, driven by the proof requirements alone.
  if (!HAS_REAL_RUN) {
    node(
      'posture-retarget-releases-then-reacquires',
      `the posture reconciler releases '${OWN_SIM}' and acquires '${OTHER_SIM}' in one apply`,
      false,
      { 'not-exercised': 'SMOKE_RUN_ID was not set, so there is no run record to reconcile' },
    );
  } else {
    const applied = await gateway('runtime.posture.apply', {
      runId: OWNER,
      posture: 'active',
      proofRequirements: [requirement({ simulator: OTHER_SIM })],
    });
    sims = await simctl();
    const status = await gateway('runtime.capability.status', { slotId: SLOT, ownerRunId: OWNER });
    const held = status.leases?.find(
      (lease) => lease.capabilityId === 'ios-simulator' && lease.state === 'acquired',
    );
    node(
      'posture-retarget-releases-then-reacquires',
      `the posture reconciler releases '${OWN_SIM}' and acquires '${OTHER_SIM}' in one apply`,
      applied.ok === true &&
        held?.parameters?.simulator === OTHER_SIM &&
        sims[OTHER_SIM]?.state === 'Booted' &&
        sims[OWN_SIM]?.state === 'Shutdown',
      {
        outcome: applied.transition?.outcome,
        failures: applied.transition?.failures,
        rejection: applied.transition?.rejection,
        leaseParameters: held?.parameters,
        other: sims[OTHER_SIM],
        own: sims[OWN_SIM],
      },
    );
  }

  // 3. Release stops the device the LEASE acquired, not the slot's default.
  await release(SLOT, OWNER);
  sims = await simctl();
  node(
    'release-stops-leased-device',
    `releasing the re-targeted lease shuts down '${OTHER_SIM}', not the slot's own '${OWN_SIM}'`,
    sims[OTHER_SIM]?.state === 'Shutdown',
    { other: sims[OTHER_SIM], own: sims[OWN_SIM] },
  );

  // 4. `recipe.rerun` with a target: the proof-plan rewrite on top of that same
  //    reconciler path. This is the acceptance criterion's own RPC.
  if (!HAS_REAL_RUN) {
    node(
      'recipe-rerun-target-rewrites-the-proof-plan',
      `\`recipe.rerun\` with a target moves the run's lease to the named device`,
      false,
      { 'not-exercised': 'SMOKE_RUN_ID was not set, so recipe.rerun has no run to replay' },
    );
  } else {
    let rerun;
    try {
      rerun = await gateway('recipe.rerun', {
        runId: OWNER,
        slotId: SLOT,
        target: { simulator: OWN_SIM },
      });
    } catch (error) {
      rerun = { error: String(error?.message ?? error).slice(0, 400) };
    }
    // Poll for the outcome rather than sleeping a guessed interval: a fixed wait
    // is both a slow pass and a flaky fail.
    const deadline = Date.now() + 120_000;
    let status;
    let held;
    let plan;
    for (;;) {
      status = await gateway('runtime.capability.status', { slotId: SLOT, ownerRunId: OWNER });
      held = status.leases?.find(
        (lease) => lease.capabilityId === 'ios-simulator' && lease.state === 'acquired',
      );
      plan = status.proofPlans?.[OWNER]?.requirements?.find(
        (entry) => entry.capabilityId === 'ios-simulator',
      );
      if (held?.parameters?.simulator === OWN_SIM && plan?.parameters?.simulator === OWN_SIM) break;
      if (Date.now() > deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    sims = await simctl();
    node(
      'recipe-rerun-target-rewrites-the-proof-plan',
      `\`recipe.rerun\` with target simulator='${OWN_SIM}' rewrites the stored plan and moves the lease back`,
      plan?.parameters?.simulator === OWN_SIM &&
        held?.parameters?.simulator === OWN_SIM &&
        sims[OWN_SIM]?.state === 'Booted' &&
        sims[OTHER_SIM]?.state === 'Shutdown',
      {
        rerun,
        storedPlan: plan,
        leaseParameters: held?.parameters,
        own: sims[OWN_SIM],
        other: sims[OTHER_SIM],
      },
    );
  }
  await release(SLOT, OWNER);

  // 5. Typed refusals. Each is a node that can fail: a regression that accepted
  //    the value would boot something, or run something, that nobody asked for.
  const badCharset = await acquire(SLOT, OWNER, {
    simulator: `${OWN_SIM}; touch /tmp/farmslot-113`,
  });
  node(
    'shell-charset-refused',
    'a device identity carrying shell meaning is refused as invalid-request, not escaped',
    badCharset.ok === false && badCharset.conflict?.kind === 'invalid-request',
    { conflict: badCharset.conflict },
  );

  const unknown = await acquire(SLOT, OWNER, { simulator: 'no-such-simulator-113' });
  sims = await simctl();
  node(
    'unknown-device-refused',
    "an identity no device on this machine matches fails the provider's own boot action",
    unknown.ok === false,
    { conflict: unknown.conflict },
  );
  await release(SLOT, OWNER);

  // 6. Cross-slot guard: a sibling slot holds the device, so re-targeting onto
  //    it is refused while leases are slot-scoped.
  const sibling = await acquire(SIBLING, SIBLING_OWNER, { simulator: OTHER_SIM });
  const blocked = sibling.ok
    ? await acquire(SLOT, OWNER, { simulator: OTHER_SIM })
    : { ok: null, conflict: { reason: 'sibling acquire failed, guard not exercised' } };
  node(
    'cross-slot-guard',
    `re-targeting onto a device slot '${SIBLING}' already holds a lease on is refused, naming that slot`,
    sibling.ok === true &&
      blocked.ok === false &&
      blocked.conflict?.kind === 'invalid-request' &&
      String(blocked.conflict?.reason ?? '').includes(SIBLING),
    { siblingAcquire: sibling.ok, siblingConflict: sibling.conflict, blocked: blocked.conflict },
  );

  // 7. The sibling's own lease was never touched by any of this.
  const siblingStatus = await gateway('runtime.capability.status', {
    slotId: SIBLING,
    ownerRunId: SIBLING_OWNER,
  });
  const siblingLease = siblingStatus.leases?.find(
    (lease) => lease.capabilityId === 'ios-simulator' && lease.state === 'acquired',
  );
  sims = await simctl();
  node(
    'sibling-lease-untouched',
    `slot '${SIBLING}' still holds its own '${OTHER_SIM}' lease and the device is still booted`,
    Boolean(siblingLease) &&
      siblingLease?.parameters?.simulator === OTHER_SIM &&
      sims[OTHER_SIM]?.state === 'Booted',
    { lease: siblingLease, other: sims[OTHER_SIM] },
  );

  // Cleanup.
  await release(SIBLING, SIBLING_OWNER);
  await release(SLOT, OWNER);
  const finalSims = await simctl();
  const finalSlot = await gateway('runtime.capability.status', { slotId: SLOT });
  const finalSibling = await gateway('runtime.capability.status', { slotId: SIBLING });

  writeEvidence({
    measured: {
      startedAt: started,
      finalDeviceState: { [OWN_SIM]: finalSims[OWN_SIM], [OTHER_SIM]: finalSims[OTHER_SIM] },
      finalLeases: {
        [SLOT]: leaseSummary(finalSlot),
        [SIBLING]: leaseSummary(finalSibling),
      },
    },
  });
}

main().catch((error) => {
  // Through the SAME merge as a clean finish. A thrown gateway() or simctl()
  // used to overwrite the artifact with four keys, destroying the CDP evidence
  // and negative proofs this driver never produced.
  console.error('smoke failed:', error?.message ?? error);
  writeEvidence({ error: String(error?.message ?? error) });
  process.exitCode = 1;
});
