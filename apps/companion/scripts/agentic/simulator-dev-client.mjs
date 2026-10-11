import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

/** Open the installed client on the proof's Metro, rather than its cached bundle. */
export async function openSimulatorDevClient(simulator) {
  const port = process.env.METRO_PORT;
  assert(/^[1-9]\d*$/.test(port ?? ''), 'Set METRO_PORT to the owned proof stack');
  const host = process.env.FARMSLOT_RECIPE_METRO_HOST ?? 'localhost';
  const scheme = process.env.SCHEME ?? 'farmslot-development';
  execFileSync('xcrun', [
    'simctl',
    'openurl',
    simulator,
    `${scheme}://expo-development-client/?url=${encodeURIComponent(`http://${host}:${port}`)}`,
  ]);
  // A previous app's pending Metro poll can consume the first status request after relaunch.
  // Wait for a structured reply from the new client before a recipe submits its HUD commands.
  const deadline = Date.now() + 60000;
  for (;;) {
    const response = await fetch(`http://${host}:${port}/farmslot-recipe/command`, {
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
    if (response.ok && result.ok && result.platform === 'ios') return;
    if (response.status !== 504 || Date.now() >= deadline)
      throw new Error(result.error ?? 'The simulator recipe bridge did not become ready');
  }
}
