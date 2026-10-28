// Run through offline-store-baseline.recipe.json on an isolated, already paired dev client.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const [phase, runId, slotId] = process.argv.slice(2);
assert(['cold', 'reconnect', 'diff'].includes(phase), 'Expected cold, reconnect or diff');
if (phase === 'diff') {
  assert(/^[a-zA-Z0-9-]+$/.test(runId ?? ''), 'Select the gate run');
  assert(/^[a-zA-Z0-9-]+$/.test(slotId ?? ''), 'Select the gate slot');
}
const simulator = process.env.IOS_SIMULATOR;
const metro = process.env.METRO_PORT;
assert(simulator, 'Select the isolated IOS_SIMULATOR');
assert(/^\d+$/.test(metro ?? ''), 'Select the isolated METRO_PORT');
const appId = process.env.FARMSLOT_RECIPE_APP_ID ?? 'net.siteed.farmslot.development';
async function observe(ref = 'offline-store-baseline') {
  const response = await fetch(`http://127.0.0.1:${metro}/farmslot-recipe/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      command: 'observeUi',
      nodeId: 'offline-store-baseline',
      payload: { refs: [ref] },
      timeout_ms: 3000,
    }),
    signal: AbortSignal.timeout(5000),
  });
  // No app is polling the relay while its native process starts.
  if (response.status === 504) return undefined;
  assert(response.ok, `Recipe relay failed with HTTP ${response.status}`);
  const result = await response.json();
  assert(result.ok, result.error ?? 'Recipe observer failed');
  return result.observations?.offlineBaseline;
}
if (phase === 'cold') {
  execFileSync('xcrun', ['simctl', 'launch', '--terminate-running-process', simulator, appId], {
    stdio: 'pipe',
  });
} else {
  const state = await observe();
  assert(state?.status === 'connected', 'Companion must be connected before measuring');
  if (phase === 'reconnect') {
    await observe('offline-store-baseline:reconnect');
  } else {
    await observe(`offline-store-baseline:diff:${slotId}`);
    execFileSync(
      'xcrun',
      ['simctl', 'openurl', simulator, `farmslot-development:///workspace/run/${runId}/diff`],
      { stdio: 'pipe' },
    );
  }
}
const deadline = Date.now() + 60_000;
while (Date.now() < deadline) {
  const state = await observe();
  if (phase === 'cold' && state?.timingSource === 'unavailable')
    throw new Error('Native startup timing is unavailable; refusing a cold-start baseline');
  // Run list reads end at the merged run list, after a version-list read's last catch-up page.
  const sample =
    phase === 'diff' ? state?.samples.find((entry) => entry.phase === phase) : state?.merged;
  if (sample?.phase === phase && state.status === 'connected') {
    console.log(
      JSON.stringify(
        {
          ...sample,
          timing:
            phase === 'cold'
              ? 'React Native startup startTime to the merged run list, at its last run.list reply after JSON parsing'
              : phase === 'reconnect'
                ? 'socket close event to the merged run list, at its last run.list reply after JSON parsing'
                : 'open gate diff to matching git.diff reply after JSON parsing',
          bytes: 'received UTF-8 gateway application frames through that reply',
        },
        null,
        2,
      ),
    );
    process.exit(0);
  }
  await delay(100);
}
throw new Error(`No ${phase} read measurement from the connected Companion`);
