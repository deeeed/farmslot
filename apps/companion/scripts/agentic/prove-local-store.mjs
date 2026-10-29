import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const phase = process.argv[2];
assert(['status', 'conformance', 'settings'].includes(phase));
const metro = process.env.METRO_PORT;
const platform = process.env.PLATFORM;
assert(/^\d+$/.test(metro ?? ''), 'Select the isolated METRO_PORT');
assert(['ios', 'android'].includes(platform), 'Select ios or android');
if (phase === 'settings') {
  if (platform === 'ios') {
    assert(process.env.IOS_SIMULATOR, 'Select the owned IOS_SIMULATOR');
    execFileSync('xcrun', [
      'simctl',
      'openurl',
      process.env.IOS_SIMULATOR,
      'farmslot-development:///settings',
    ]);
  } else {
    const serial = process.env.ADB_SERIAL ?? process.env.ANDROID_SERIAL;
    assert(serial, 'Select the owned Android serial');
    execFileSync('adb', [
      '-s',
      serial,
      'shell',
      'am',
      'start',
      '-a',
      'android.intent.action.VIEW',
      '-d',
      'farmslot-development:///settings',
      'net.siteed.farmslot.development',
    ]);
  }
  console.log(JSON.stringify({ result: 'PASS', platform, phase }));
  process.exit(0);
}
async function observe() {
  const timeout = phase === 'conformance' ? 30000 : 3000;
  const response = await fetch(`http://127.0.0.1:${metro}/farmslot-recipe/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      command: 'observeUi',
      nodeId: `local-store-${phase}`,
      payload: { refs: [`local-store:${phase}`] },
      timeout_ms: timeout,
    }),
    signal: AbortSignal.timeout(timeout + 2000),
  });
  assert(response.ok, `Recipe relay HTTP ${response.status}`);
  const reply = await response.json();
  assert(reply.ok, reply.error);
  return reply.observations.localStore;
}
const deadline = Date.now() + 60000;
let state;
while (Date.now() < deadline) {
  state = await observe();
  assert.equal(state.platform, platform, 'The recipe relay answered from a different platform');
  assert.equal(state.result, 'PASS', JSON.stringify(state));
  const ready =
    phase === 'conformance'
      ? state.checks === 18
      : state.cache && !state.notice && state.diagnostics.storeCount > 0;
  if (ready) {
    assert.equal(state.diagnostics.integrity, 'ok');
    const directory = state.diagnostics.directory.toLowerCase();
    assert(
      directory.includes('/cache/') || directory.includes('/caches/'),
      'SQLite must use the platform cache directory',
    );
    console.log(JSON.stringify({ phase, ...state }));
    process.exit(0);
  }
  await delay(50);
}
throw new Error(`The app did not open its persistent resource store: ${JSON.stringify(state)}`);
