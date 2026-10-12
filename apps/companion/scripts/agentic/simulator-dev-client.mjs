import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

function simulatorMetroOrigin() {
  const port = process.env.METRO_PORT;
  assert(/^[1-9]\d*$/.test(port ?? ''), 'Set METRO_PORT to the owned proof stack');
  const host = process.env.FARMSLOT_RECIPE_METRO_HOST ?? 'localhost';
  return `http://${host}:${port}`;
}

export function devClientUrl(origin = simulatorMetroOrigin()) {
  const scheme = process.env.SCHEME ?? 'farmslot-development';
  const url = new URL(`${scheme}://expo-development-client/`);
  url.searchParams.set('url', origin);
  url.searchParams.set('disableOnboarding', '1');
  return url.toString();
}

/** Open the installed client on the proof's Metro, rather than its cached bundle. */
export async function openSimulatorDevClient(simulator, { waitForBridge = true } = {}) {
  execFileSync('xcrun', ['simctl', 'openurl', simulator, devClientUrl()]);
  if (!waitForBridge) return;
  await waitForSimulatorRecipeBridge();
}

export async function waitForSimulatorRecipeBridge({ platform = 'ios' } = {}) {
  const origin = simulatorMetroOrigin();
  // A previous app's pending Metro poll can consume the first status request after relaunch.
  // Wait for a structured reply from the new client before a recipe submits its HUD commands.
  const deadline = Date.now() + 60000;
  for (;;) {
    const response = await fetch(`${origin}/farmslot-recipe/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        command: 'status',
        nodeId: 'dev-client-ready',
        payload: {},
        timeout_ms: 4000,
      }),
    });
    const result = await response.json();
    if (response.ok && result.ok && result.platform === platform) return;
    if (response.status !== 504 || Date.now() >= deadline)
      throw new Error(result.error ?? 'The simulator recipe bridge did not become ready');
  }
}

export async function openAndroidDevClient(serial, bundleId) {
  execFileSync('adb', [
    '-s',
    serial,
    'shell',
    'am',
    'start',
    '-W',
    '-a',
    'android.intent.action.VIEW',
    '-d',
    `'${devClientUrl().replaceAll("'", "'\\''")}'`,
    '-p',
    bundleId,
  ]);
  await waitForSimulatorRecipeBridge({ platform: 'android' });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.equal(process.argv[2], 'url', 'Usage: simulator-dev-client.mjs url <metro-origin>');
  process.stdout.write(devClientUrl(process.argv[3]));
}
