import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import type { PRPushListResult } from '../packages/protocol/src/index.js';
import { GatewayClient } from '../packages/cli/src/gateway-client.js';
import { loadCheckoutEnv } from '../packages/cli/src/onboarding/env-file.js';

loadCheckoutEnv(fileURLToPath(new URL('../', import.meta.url)));
const client = new GatewayClient({
  url: process.env.GW_URL ?? 'ws://127.0.0.1:7777',
  timeout: 15_000,
});
const connection = await client.connect();
const second = await new GatewayClient({
  url: process.env.GW_URL ?? 'ws://127.0.0.1:7777',
  timeout: 15_000,
}).connect();
const events: PRPushListResult[] = [];
second.onEvent((event) => {
  if (event.event === 'prPush.updated') events.push(event.payload as PRPushListResult);
});
const installationId = `push-validation-${randomUUID()}`;
const input = {
  installationId,
  token: `ExpoPushToken[${randomUUID()}]`,
  platform: 'ios',
  profileId: 'push-validation',
  enabled: false,
  sound: false,
};
try {
  const result = await connection.call<{ device: { id: string; revision: number } }>(
    'prPush.register',
    input,
  );
  const replay = await connection.call<typeof result>('prPush.register', {
    ...input,
    expectedRevision: result.device.revision,
  });
  assert.equal(
    replay.device.id,
    result.device.id,
    'Reconnection registration must preserve the device identity',
  );
  assert.equal(
    replay.device.revision,
    result.device.revision,
    'Identical registration cannot invalidate delivery work',
  );
  assert(
    events.some((event) => event.devices.some((device) => device.id === result.device.id)),
    'Registration must broadcast to the second client',
  );
  await assert.rejects(
    connection.call('prPush.register', {
      ...input,
      enabled: true,
      expectedRevision: result.device.revision + 1,
    }),
    /settings changed/,
  );
  assert.equal(
    (await second.call<PRPushListResult>('prPush.list', {})).devices.find(
      (device) => device.id === result.device.id,
    )?.enabled,
    false,
    'Stale registration cannot enable push',
  );
  await assert.rejects(connection.call('prPush.register', { ...input, token: 'invalid-token' }));
  await assert.rejects(
    connection.call('prPush.register', {
      ...input,
      expectedRevision: result.device.revision,
      platform: ['ios'],
    }),
    /Platform/,
  );
  const inventory = await second.call<PRPushListResult>('prPush.list', {});
  assert(inventory.devices.some((device) => device.id === result.device.id && !device.enabled));
  assert(
    !JSON.stringify(inventory).includes(input.token),
    'Public inventory must not expose delivery tokens',
  );
  assert(
    !inventory.deliveries.some((delivery) => delivery.deviceId === result.device.id),
    'Disabled registration must never send provider requests',
  );
  await connection.call('prPush.unregister', { installationId });
  const final = await second.call<PRPushListResult>('prPush.list', {});
  assert.equal(final.devices.find((device) => device.id === result.device.id)?.enabled, false);
  console.log(
    JSON.stringify({
      passed: true,
      installationId,
      deviceId: result.device.id,
      registrationReplay: true,
      redacted: true,
      disabled: true,
    }),
  );
} finally {
  await connection.call('prPush.unregister', { installationId });
  connection.close();
  second.close();
}
