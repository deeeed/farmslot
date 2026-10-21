import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

import { withOwnedGatewayOffline } from '../../../command-center/scripts/owned-gateway-outage.mjs';

const execute = promisify(execFile);
const action = process.argv[2] ?? 'ready';
assert(
  ['ready', 'stale', 'loading', 'receipt', 'reconnect', 'cold-offline', 'stale-age'].includes(
    action,
  ),
);
const metro = process.env.METRO_PORT;
const platform = process.env.PLATFORM;
assert(/^\d+$/.test(metro ?? ''), 'Select the isolated METRO_PORT');
assert(['ios', 'android'].includes(platform), 'Select the actual target platform');
async function snapshot(ref = 'sources-cache:snapshot', timeout = 3000) {
  const response = await fetch(`http://127.0.0.1:${metro}/farmslot-recipe/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      command: 'observeUi',
      nodeId: 'sources-cache-snapshot',
      payload: { refs: [ref] },
      timeout_ms: timeout,
    }),
    signal: AbortSignal.timeout(timeout + 2000),
  });
  if (response.status === 504) return undefined; // The owned dev build is attaching during cold start.
  assert(response.ok, `Recipe relay HTTP ${response.status}`);
  const reply = await response.json();
  assert(reply.ok, reply.error);
  const state =
    ref === 'sources-cache:reconnect'
      ? reply.observations.sourcesReconnect
      : reply.observations.sourcesCache;
  assert.equal(state.platform, platform, 'The relay answered from a different platform');
  return state;
}
if (action === 'reconnect') {
  const proof = await snapshot('sources-cache:reconnect', 120000);
  assert.equal(proof?.result, 'PASS', JSON.stringify(proof));
  console.log(JSON.stringify(proof));
  process.exit(0);
}
async function until(ready) {
  const deadline = Date.now() + 120000;
  let state;
  do {
    state = await snapshot();
    if (state && ready(state)) return state;
    await delay(50);
  } while (Date.now() < deadline);
  assert.fail(`The production Sources view did not settle: ${JSON.stringify(state)}`);
}
if (action === 'receipt') {
  assert(process.env.FARMSLOT_SOURCE_SYNC_RECEIPT, 'Select the receipt from the real source sync');
  const target = JSON.parse(await readFile(process.env.FARMSLOT_SOURCE_SYNC_RECEIPT, 'utf8'));
  assert(
    /^[a-zA-Z0-9._-]+$/.test(target.sourceId) &&
      /^[a-zA-Z0-9._-]+$/.test(target.nodeId) &&
      /^[0-9a-f]{64}$/.test(target.lockDigest) &&
      Number.isSafeInteger(target.startedAt),
  );
  const state = await until(
    (value) =>
      value.freshness === 'ready' &&
      value.observedAt >= target.startedAt &&
      value.panels.some((panel) =>
        panel.rows?.some(
          (row) =>
            row.sourceId === target.sourceId &&
            row.materializations.some(
              (entry) =>
                entry.nodeId === target.nodeId &&
                entry.lockDigest === target.lockDigest &&
                Date.parse(entry.verifiedAt) >= target.startedAt &&
                !entry.drift.length,
            ),
        ),
      ),
  );
  console.log(JSON.stringify({ result: 'PASS', action, ...target, state }));
  process.exit(0);
}
if (action !== 'cold-offline' && action !== 'stale-age') {
  const state = await until(
    (value) => value.freshness === action && (action === 'loading' || value.selections),
  );
  if (action === 'stale') assert.equal(state.online, false);
  console.log(JSON.stringify(state));
  process.exit(0);
}

const bundle = 'net.siteed.farmslot.development';
const simulator = process.env.IOS_SIMULATOR;
const serial = process.env.ADB_SERIAL ?? process.env.ANDROID_SERIAL;
if (platform === 'ios') assert(simulator, 'Select the owned IOS_SIMULATOR');
else assert(serial?.startsWith('emulator-'), 'Select the owned Android emulator');
async function settings() {
  if (platform === 'ios')
    await execute('xcrun', ['simctl', 'openurl', simulator, 'farmslot-development:///settings']);
  else
    await execute('adb', [
      '-s',
      serial,
      'shell',
      'am',
      'start',
      '-a',
      'android.intent.action.VIEW',
      '-d',
      'farmslot-development:///settings',
      bundle,
    ]);
}
async function restart() {
  const link = `farmslot-development://expo-development-client/?url=${encodeURIComponent(`http://127.0.0.1:${metro}`)}`;
  if (platform === 'ios') {
    await execute('xcrun', ['simctl', 'terminate', simulator, bundle]);
    // openurl cold-launches the dev client directly; launching first can initialize two JS bridges.
    await execute('xcrun', ['simctl', 'openurl', simulator, link]);
  } else {
    for (const port of [metro, process.env.GATEWAY_PORT]) {
      assert(/^\d+$/.test(port ?? ''));
      await execute('adb', ['-s', serial, 'reverse', `tcp:${port}`, `tcp:${port}`]);
    }
    await execute('adb', ['-s', serial, 'shell', 'am', 'force-stop', bundle]);
    await execute('adb', [
      '-s',
      serial,
      'shell',
      'am',
      'start',
      '-a',
      'android.intent.action.VIEW',
      '-d',
      link,
      bundle,
    ]);
  }
}
await settings();
const before = await until(
  (value) => value.freshness === 'ready' && value.panels.some((panel) => panel.line),
);
if (action === 'stale-age') {
  const session = process.env.FARMSLOT_NATIVE_SESSION;
  assert(session, 'Select the existing owned native UI session');
  async function renderedAge() {
    const { stdout } = await execute(
      'yarn',
      [
        'workspace',
        '@farmslot/mobile',
        'exec',
        'agent-device',
        'snapshot',
        '-i',
        '--session',
        session,
        '--json',
      ],
      { timeout: 30000, maxBuffer: 2 * 1024 * 1024 },
    );
    const reply = JSON.parse(stdout);
    assert(reply.success, 'The native accessibility snapshot failed');
    const label = reply.data.nodes.find((node) => node.identifier === 'sources-stale');
    const age = label?.label ?? label?.text ?? label?.value;
    assert(typeof age === 'string' && age.includes('old'), 'Read the actual rendered stale age');
    return age;
  }
  const { stoppedPid, evidence } = await withOwnedGatewayOffline(async () => {
    const stale = await until((value) => value.freshness === 'stale');
    const firstAge = await renderedAge();
    let nextAge = firstAge;
    const deadline = Date.now() + 70000;
    while (nextAge === firstAge && Date.now() < deadline) {
      await delay(50);
      nextAge = await renderedAge();
    }
    assert.notEqual(nextAge, firstAge, 'The rendered native age must advance while offline');
    const aged = await snapshot();
    assert.equal(aged.observedAt, stale.observedAt);
    assert.deepEqual(aged.selections, stale.selections);
    assert.deepEqual(
      aged.panels.map((panel) => panel.rows),
      stale.panels.map((panel) => panel.rows),
    );
    assert(aged.panels.every((panel) => !panel.interactive && !panel.canEdit));
    if (process.env.FARMSLOT_SOURCES_SCREENSHOT)
      await execute(
        'yarn',
        [
          'workspace',
          '@farmslot/mobile',
          'exec',
          'agent-device',
          'screenshot',
          process.env.FARMSLOT_SOURCES_SCREENSHOT,
          '--session',
          session,
          '--json',
        ],
        { timeout: 30000, maxBuffer: 1024 * 1024 },
      );
    return { firstAge, nextAge, observedAt: aged.observedAt };
  });
  const recovered = await until((value) => value.freshness === 'ready');
  assert.notEqual(recovered.epoch, before.epoch);
  console.log(JSON.stringify({ result: 'PASS', action, platform, stoppedPid, ...evidence }));
  process.exit(0);
}
const {
  stoppedPid,
  evidence: { stale, cold },
} = await withOwnedGatewayOffline(async () => {
  const stale = await until(
    (value) => value.freshness === 'stale' && value.panels.some((panel) => panel.line),
  );
  await restart();
  await until((value) => value.startedAt > before.startedAt);
  await settings();
  const cold = await until(
    (value) => value.freshness === 'stale' && value.panels.some((panel) => panel.line),
  );
  assert.equal(cold.online, false);
  assert.equal(
    cold.observedAt,
    stale.observedAt,
    'Cold offline startup must keep the stored observation time',
  );
  assert.deepEqual(cold.selections, stale.selections);
  assert(cold.panels.every((panel) => !panel.interactive && !panel.canEdit && !panel.canRetry));
  assert(cold.panels.every((panel) => panel.age.includes('old')));
  const screenshot = process.env.FARMSLOT_SOURCES_SCREENSHOT;
  if (screenshot) {
    if (platform === 'ios')
      await execute('xcrun', ['simctl', 'io', simulator, 'screenshot', screenshot]);
    else {
      const { stdout } = await execute('adb', ['-s', serial, 'exec-out', 'screencap', '-p'], {
        encoding: 'buffer',
        maxBuffer: 8 * 1024 * 1024,
      });
      await writeFile(screenshot, stdout);
    }
  }
  return { stale, cold };
});
const recovered = await until(
  (value) => value.freshness === 'ready' && value.observedAt > cold.observedAt,
);
assert.notEqual(recovered.epoch, before.epoch, 'Restart must establish a new gateway epoch');
assert.equal(
  recovered.pinRevision,
  cold.pinRevision,
  'Reconnect must not replay a source mutation',
);
console.log(
  JSON.stringify({ result: 'PASS', action, platform, stoppedPid, before, stale, cold, recovered }),
);
