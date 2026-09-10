#!/usr/bin/env tsx
// Cleanup only new Companion validation requests created by the current recipe invocation.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { GatewayClient } from '../packages/cli/src/gateway-client.js';
import { loadCheckoutEnv } from '../packages/cli/src/onboarding/env-file.js';
import { parseGitHubPullUrl, type PRRulesListResult } from '../packages/protocol/src/index.js';
loadCheckoutEnv(fileURLToPath(new URL('../', import.meta.url)));
const after = process.env.INTAKE_CREATED_AFTER;
const pr = parseGitHubPullUrl(process.env.INTAKE_PR_URL);
assert(
  after && Number.isFinite(Date.parse(after)) && pr,
  'Set INTAKE_CREATED_AFTER and INTAKE_PR_URL',
);
const client = new GatewayClient({
  url: process.env.GW_URL ?? 'ws://127.0.0.1:7777',
  timeout: 30_000,
});
const connection = await client.connect();
try {
  const state = await connection.call<PRRulesListResult>('prRules.list');
  let cancelled = 0;
  for (const request of state.submissions ?? []) {
    if (
      request.request.source.client !== 'companion' ||
      request.cancelledAt ||
      request.createdAt < after ||
      request.request.pr.repo.toLowerCase() !== pr.repo.toLowerCase() ||
      request.request.pr.number !== pr.number
    )
      continue;
    const team = state.teams.find((team) => team.id === request.request.teamId);
    assert(
      team?.config.name === 'Direct review failure validation' &&
        team.config.account.login === process.env.INTAKE_ERROR_GITHUB_LOGIN,
      'Never cancel a real operator request through validation cleanup',
    );
    assert(
      !state.intents.some((intent) => intent.id === request.intentId && intent.runId),
      'A running request requires its normal lifecycle controls',
    );
    await connection.call('prReview.cancel', { id: request.id, revision: request.revision });
    cancelled++;
  }
  console.log(JSON.stringify({ cancelled }));
} finally {
  connection.close();
}
