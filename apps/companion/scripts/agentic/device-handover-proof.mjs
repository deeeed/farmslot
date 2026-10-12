// Live tier: two provider-owned sessions on an explicitly selected idle simulator.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { createAgentDeviceClient } from 'agent-device';

import { processAlive, providerDaemonPid, waitForProof } from './proof-gateway.mjs';

const proof = process.env.COMPANION_DEVICE_HANDOVER_PROOF_DIR;
const simulator = process.env.IOS_SIMULATOR;
assert(
  proof && simulator,
  'Set a fresh COMPANION_DEVICE_HANDOVER_PROOF_DIR and owned IOS_SIMULATOR',
);
assert(!fs.existsSync(proof), 'Use fresh provider state for each live handover proof');
assert.equal(process.env.AGENT_DEVICE_IOS_RUNNER_IDLE_STOP_MS, '100');
assert.equal(process.env.AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS, '10000');
fs.mkdirSync(proof, { recursive: true });
const clients = ['before', 'after'].map((name) => ({
  stateDir: path.join(proof, name),
  session: `handover-${name}`,
  client: createAgentDeviceClient({ stateDir: path.join(proof, name) }),
  opened: false,
}));
assert(/^[0-9a-f-]{36}$/i.test(simulator), 'Select the owned simulator by UDID');
const selection = { platform: 'ios', udid: simulator, app: 'net.siteed.farmslot.development' };
async function close() {
  for (const owner of clients) {
    if (owner.opened) {
      await owner.client.sessions.close({ session: owner.session, shutdown: false });
      owner.opened = false;
    }
  }
}
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, async () => {
    await close();
    process.exit(1);
  });

try {
  const [before, after] = clients;
  await before.client.apps.open({ ...selection, session: before.session });
  before.opened = true;
  await before.client.capture.snapshot({ ...selection, session: before.session, forceFull: true });
  const beforePid = providerDaemonPid(before.stateDir);
  const guardedUntil = Date.now() + 11000;
  await waitForProof(() => {
    assert(processAlive(beforePid), 'An active session must prevent idle daemon exit');
    return Date.now() >= guardedUntil;
  }, 12000);
  await before.client.sessions.close({ session: before.session, shutdown: false });
  before.opened = false;
  // Reap is provider-owned and cannot interrupt an open session. Wait for its own exit.
  await waitForProof(() => !processAlive(beforePid), 20000);
  await after.client.apps.open({ ...selection, session: after.session });
  after.opened = true;
  const snapshot = await after.client.capture.snapshot({
    ...selection,
    session: after.session,
    forceFull: true,
  });
  const afterPid = providerDaemonPid(after.stateDir);
  await close();
  await waitForProof(() => !processAlive(afterPid), 20000);
  console.log(
    JSON.stringify({
      activeOwnerPreserved: true,
      closedOwnerExited: true,
      successorSnapshot: Boolean(snapshot),
      successorExited: true,
      beforePid,
      afterPid,
    }),
  );
} finally {
  await close();
}
