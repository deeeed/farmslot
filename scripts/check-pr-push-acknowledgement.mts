import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { PRPushListResult, PRWatchResult } from '../packages/protocol/src/index.js';
import { GatewayClient } from '../packages/cli/src/gateway-client.js';
import { loadCheckoutEnv } from '../packages/cli/src/onboarding/env-file.js';
loadCheckoutEnv(fileURLToPath(new URL('../', import.meta.url)));
const sourceId = process.env.PR_PUSH_ATTENTION_ID;
assert(sourceId?.startsWith('monitor:'), 'Supply the historical validation incident ID');
const [, monitorId, incidentId] = sourceId.split(':');
assert(monitorId && incidentId);
const client = await new GatewayClient({
  url: process.env.GW_URL ?? 'ws://127.0.0.1:7777',
  timeout: 15000,
}).connect();
try {
  const state = await client.call<PRPushListResult>('prPush.list', {});
  const attention = state.attention.find((item) => item.id === sourceId);
  const { monitor } = await client.call<PRWatchResult>('prWatch.get', { id: monitorId });
  assert.equal(monitor.lifecycle, 'stopped', 'Validation must preserve the stopped subscription');
  const incident = monitor.incidents.find((item) => item.id === incidentId);
  assert(
    incident?.acknowledgedAt && attention?.acknowledgedAt,
    'The native acknowledgement must persist in both attention and the owner incident',
  );
  assert.equal(
    incident.resolvedAt,
    undefined,
    'Acknowledgement must not claim GitHub resolved the conflict',
  );
  assert.equal(incident.attemptCount, 0, 'Acknowledgement must not start a repair attempt');
  assert.equal(
    attention.current,
    false,
    'Historical attention remains historical after acknowledgement',
  );
  console.log(
    JSON.stringify({
      passed: true,
      sourceId,
      acknowledged: true,
      githubResolutionUnchanged: true,
      stopped: true,
    }),
  );
} finally {
  client.close();
}
