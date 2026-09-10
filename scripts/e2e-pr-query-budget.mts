#!/usr/bin/env tsx
// Read-only proof while the selected account's GraphQL quota is already exhausted.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { GatewayClient } from '../packages/cli/src/gateway-client.js';
import { loadCheckoutEnv } from '../packages/cli/src/onboarding/env-file.js';
import type { PRRulePreviewResult } from '../packages/protocol/src/index.js';
loadCheckoutEnv(fileURLToPath(new URL('../', import.meta.url)));
const id = process.env.PR_RULE_VALIDATION_ID;
assert(id, 'Set a rule bound to an account with an already-exhausted GraphQL quota');
const client = new GatewayClient({
  url: process.env.GW_URL ?? 'ws://127.0.0.1:7777',
  timeout: 30_000,
});
const connection = await client.connect();
try {
  const first = await connection.call<PRRulePreviewResult>('prRules.preview', { id });
  assert.equal(first.preview.complete, false);
  assert.match(
    first.preview.sourceErrors.join('; '),
    /rate limit|query budget is reserved/i,
    'This scenario requires an existing provider quota failure',
  );
  const second = await connection.call<PRRulePreviewResult>('prRules.preview', { id });
  assert.equal(second.preview.complete, false);
  assert.match(
    second.preview.sourceErrors.join('; '),
    /GitHub query budget is reserved; next eligible read at/,
    'A subsequent read must use the learned reset boundary',
  );
  console.log(
    JSON.stringify({
      passed: true,
      failedReadObserved: true,
      subsequentReadDeferred: true,
      reason: second.preview.sourceErrors,
    }),
  );
} finally {
  connection.close();
}
