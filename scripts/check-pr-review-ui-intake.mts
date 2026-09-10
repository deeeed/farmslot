#!/usr/bin/env tsx
// Read-only protocol assertions paired with the Command Center intake recipe.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { GatewayClient } from '../packages/cli/src/gateway-client.js';
import { loadCheckoutEnv } from '../packages/cli/src/onboarding/env-file.js';
import {
  parseGitHubPullUrl,
  type PRRulesListResult,
  type QueueItem,
} from '../packages/protocol/src/index.js';

loadCheckoutEnv(fileURLToPath(new URL('../', import.meta.url)));
const phase = process.argv[2];
assert(
  ['before', 'submitted', 'cancelled'].includes(phase),
  'Expected before, submitted or cancelled',
);
const pr = parseGitHubPullUrl(process.env.INTAKE_PR_URL);
assert(pr, 'Set INTAKE_PR_URL');
const client = new GatewayClient({
  url: process.env.GW_URL ?? 'ws://127.0.0.1:7777',
  timeout: 15_000,
});
const connection = await client.connect();
try {
  const state = await connection.call<PRRulesListResult>('prRules.list');
  const requests = (state.submissions ?? [])
    .filter(
      (item) =>
        item.request.source.client === (process.env.INTAKE_CLIENT ?? 'command-center') &&
        item.request.pr.repo.toLowerCase() === pr.repo.toLowerCase() &&
        item.request.pr.number === pr.number,
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (phase === 'before')
    assert.equal(
      requests.filter((item) => !item.cancelledAt).length,
      0,
      'Do not interfere with active operator requests',
    );
  else {
    const request = requests[0];
    assert(request, 'The UI must persist an actual request through the gateway');
    assert.equal(
      state.teams.find((team) => team.id === request.request.teamId)?.config.name,
      'Direct review failure validation',
    );
    assert.equal(request.request.autoStart, false);
    assert.equal(request.request.review?.validationDepth, 'full-live');
    assert.equal(request.request.review?.sessionIntent, 'resume');
    if (phase === 'submitted') {
      assert(!request.cancelledAt);
      assert.match(request.error ?? '', /unavailable/);
    } else assert(request.cancelledAt, 'UI cancellation must persist');
    const { items } = await connection.call<{ items: QueueItem[] }>('dispatch.queue.list');
    assert(
      !items.some((item) => item.prWork && item.prWork.sourceId === request.intentId),
      'Unavailable/cancelled intake cannot dispatch work',
    );
  }
  console.log(JSON.stringify({ passed: true, phase }));
} finally {
  connection.close();
}
