#!/usr/bin/env node
/**
 * MANUAL-000113 live scenario: re-target a capability lease at another device
 * through the production dev gateway (ws://localhost:7801).
 *
 * Every assertion reads a structured signal — `xcrun simctl list -j devices`
 * for device state, gateway RPC results for lease state. No pane text.
 */
import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { promisify } from 'node:util';

const run = promisify(execFile);
const GW = 'ws://localhost:7801';
const HOME = '/Users/deeeed/.farmslot-dev';
const ROOT = '/Users/deeeed/dev/farmslot';
const CDP = `${ROOT}/apps/command-center/scripts/cdp.mjs`;

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
const OWNER = `smoke-113-${process.pid}`;
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

async function main() {
  const started = new Date().toISOString();

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

  // 2. Re-target: release the old device lease, acquire the new identity.
  await release(SLOT, OWNER);
  const retarget = await acquire(SLOT, OWNER, { simulator: OTHER_SIM });
  sims = await simctl();
  node(
    'retarget-boots-named-device',
    `acquiring with simulator='${OTHER_SIM}' boots THAT device and leaves the slot's own one shut down`,
    retarget.ok === true &&
      retarget.lease?.parameters?.simulator === OTHER_SIM &&
      sims[OTHER_SIM]?.state === 'Booted' &&
      sims[OWN_SIM]?.state === 'Shutdown',
    {
      acquire: retarget.ok,
      parameters: retarget.lease?.parameters,
      other: sims[OTHER_SIM],
      own: sims[OWN_SIM],
      conflict: retarget.conflict,
    },
  );

  // 3. Release runs against the device the lease acquired, not the slot default.
  await release(SLOT, OWNER);
  sims = await simctl();
  node(
    'release-stops-leased-device',
    `releasing the re-targeted lease shuts down '${OTHER_SIM}'`,
    sims[OTHER_SIM]?.state === 'Shutdown',
    { other: sims[OTHER_SIM] },
  );

  // 4. Re-target back to the slot's own device.
  const back = await acquire(SLOT, OWNER, undefined);
  sims = await simctl();
  node(
    'retarget-back',
    `acquiring with no parameters again boots '${OWN_SIM}' and leaves '${OTHER_SIM}' shut down`,
    back.ok === true && sims[OWN_SIM]?.state === 'Booted' && sims[OTHER_SIM]?.state === 'Shutdown',
    { acquire: back.ok, own: sims[OWN_SIM], other: sims[OTHER_SIM], conflict: back.conflict },
  );
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

  const artifact = {
    item: 'MANUAL-000113',
    scenario: 're-target validation to another device',
    gateway: GW,
    slot: SLOT,
    siblingSlot: SIBLING,
    ownDevice: OWN_SIM,
    retargetDevice: OTHER_SIM,
    startedAt: started,
    completedAt: new Date().toISOString(),
    nodes,
    ok: nodes.every((entry) => entry.ok),
    finalDeviceState: { [OWN_SIM]: finalSims[OWN_SIM], [OTHER_SIM]: finalSims[OTHER_SIM] },
    finalLeases: {
      [SLOT]: (finalSlot.leases ?? []).map((lease) => ({
        capabilityId: lease.capabilityId,
        state: lease.state,
        parameters: lease.parameters,
        owner: lease.owner,
      })),
      [SIBLING]: (finalSibling.leases ?? []).map((lease) => ({
        capabilityId: lease.capabilityId,
        state: lease.state,
        parameters: lease.parameters,
        owner: lease.owner,
      })),
    },
  };
  writeFileSync(
    `${ROOT}/artifacts/device-retarget-smoke.json`,
    `${JSON.stringify(artifact, null, 2)}\n`,
  );
  console.log(`\nwrote artifacts/device-retarget-smoke.json — ok=${artifact.ok}`);
  process.exitCode = artifact.ok ? 0 : 1;
}

main().catch((error) => {
  console.error('smoke failed:', error?.message ?? error);
  writeFileSync(
    `${ROOT}/artifacts/device-retarget-smoke.json`,
    `${JSON.stringify({ item: 'MANUAL-000113', ok: false, error: String(error?.message ?? error), nodes }, null, 2)}\n`,
  );
  process.exitCode = 1;
});
