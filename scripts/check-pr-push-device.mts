import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { PRPushListResult } from '../packages/protocol/src/index.js';
import { GatewayClient } from '../packages/cli/src/gateway-client.js';
import { loadCheckoutEnv } from '../packages/cli/src/onboarding/env-file.js';
loadCheckoutEnv(fileURLToPath(new URL('../', import.meta.url)));
const connection = await new GatewayClient({
  url: process.env.GW_URL ?? 'ws://127.0.0.1:7777',
  timeout: 15000,
}).connect();
try {
  const state = await connection.call<PRPushListResult>('prPush.list', {});
  const device = state.devices.find(
    (device) =>
      device.platform === process.argv[2] &&
      device.enabled &&
      device.installationId.startsWith('companion-'),
  );
  assert(device, 'A real Companion installation must be registered and enabled');
  assert(!('token' in device), 'Device token cannot appear in a public response');
  console.log(
    JSON.stringify({
      passed: true,
      deviceId: device.id,
      installationId: device.installationId,
      profileId: device.profileId,
    }),
  );
} finally {
  connection.close();
}
