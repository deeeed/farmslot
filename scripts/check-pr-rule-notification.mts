#!/usr/bin/env tsx
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { GatewayClient } from '../packages/cli/src/gateway-client.js';
import { loadCheckoutEnv } from '../packages/cli/src/onboarding/env-file.js';
import type { PRRulesListResult } from '../packages/protocol/src/index.js';

loadCheckoutEnv(fileURLToPath(new URL('../', import.meta.url)));
const id = process.argv[2];
assert(/^[0-9a-f]{64}$/.test(id ?? ''), 'Supply the notification ID from the live rule scenario');
const client = new GatewayClient({
  url: process.env.GW_URL ?? 'ws://127.0.0.1:7777',
  timeout: 15_000,
});
const connection = await client.connect();
try {
  const deadline = Date.now() + 10_000;
  let acknowledged = false;
  while (Date.now() < deadline) {
    const state = await connection.call<PRRulesListResult>('prRules.list');
    if (state.notifications?.find((note) => note.id === id)?.acknowledgedAt) {
      acknowledged = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert(acknowledged, 'UI acknowledgement must persist through the gateway');
  console.log(JSON.stringify({ passed: true, acknowledged: id }));
} finally {
  connection.close();
}
