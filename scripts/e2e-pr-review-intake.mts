#!/usr/bin/env tsx
// Proves direct intake through real gateway RPCs. Full mode requires a disabled slot.
// INTAKE_EXPECT_OBSERVATION_ERROR=1 uses INTAKE_ERROR_GITHUB_LOGIN to prove durable failure/cancellation.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { GatewayClient } from '../packages/cli/src/gateway-client.js';
import { loadCheckoutEnv } from '../packages/cli/src/onboarding/env-file.js';
import { parseGitHubPullUrl } from '../packages/protocol/src/index.js';
import type {
  FleetStatus,
  PRReviewRequestResult,
  PRRulesListResult,
  PRTeamSaveResult,
  QueueItem,
} from '../packages/protocol/src/index.js';

loadCheckoutEnv(fileURLToPath(new URL('../', import.meta.url)));
const parsed = parseGitHubPullUrl(process.env.INTAKE_PR_URL);
const project = process.env.INTAKE_PROJECT;
const slotId = process.env.INTAKE_SLOT;
const expectError = process.env.INTAKE_EXPECT_OBSERVATION_ERROR === '1';
const login = expectError ? process.env.INTAKE_ERROR_GITHUB_LOGIN : process.env.INTAKE_GITHUB_LOGIN;
assert(
  parsed && login && project && slotId,
  expectError
    ? 'Set INTAKE_PR_URL, INTAKE_ERROR_GITHUB_LOGIN, INTAKE_PROJECT and INTAKE_SLOT'
    : 'Set INTAKE_PR_URL, INTAKE_GITHUB_LOGIN, INTAKE_PROJECT and INTAKE_SLOT',
);
const client = new GatewayClient({
  url: process.env.GW_URL ?? 'ws://127.0.0.1:7777',
  timeout: 15_000,
});
const connection = await client.connect();
const observer = await client.connect().catch((error) => {
  connection.close();
  throw error;
});
const updates: PRRulesListResult[] = [];
observer.onEvent((event) => {
  if (event.event === 'prRules.updated') updates.push(event.payload as PRRulesListResult);
});
let receipt: PRReviewRequestResult | undefined;
try {
  const { fleet } = await connection.call<{ fleet: FleetStatus }>('fleet.status');
  assert(
    fleet.slots.some((slot) => slot.slot === slotId && slot.project === project && !slot.enabled),
    'Choose a disabled slot; this scenario must not launch a worker',
  );
  const before = await connection.call<PRRulesListResult>('prRules.list');
  const name = expectError
    ? 'Direct review failure validation'
    : 'Direct review gateway validation';
  const existing = before.teams.find((team) => team.config.name === name);
  assert(
    !before.rules.some((rule) => rule.enabled && rule.config.teamId === existing?.id),
    'Do not change a validation profile with enabled rules',
  );
  assert(
    !before.submissions?.some((item) => item.request.teamId === existing?.id && !item.cancelledAt),
    'Clean up prior validation requests before reusing this team',
  );
  const { team } = await connection.call<PRTeamSaveResult>('prRules.teamSave', {
    id: existing?.id,
    revision: existing?.revision,
    config: {
      name,
      account: { host: 'github.com', login },
      sources: [{ kind: 'repository', repo: parsed.repo }],
      predicate: { kind: 'compare', field: 'state', operator: 'equals', value: 'open' },
      repositories: [
        { repo: parsed.repo, project, reviewProfile: 'direct-validation', excludedLabels: [] },
      ],
      execution: {
        slotPolicy: { kind: 'exact', slotId },
        models: [{ runner: 'codex', model: 'gpt-6-astra', effort: 'high' }],
      },
      githubTeams: [],
      notificationPrincipalIds: [],
    },
  });
  const request = {
    teamId: team.id,
    pr: { host: 'github.com', repo: parsed.repo, number: parsed.number },
    idempotencyKey: randomUUID(),
    autoStart: true,
    review: {
      sessionIntent: 'resume',
      scope: 'incremental',
      validationDepth: 'full-live',
      busySession: 'wait',
    },
    source: { client: 'gateway-validation', requester: 'external-user-reference' },
  };
  receipt = await connection.call<PRReviewRequestResult>(
    'prReview.submit',
    { request },
    { timeoutMs: 3_000 },
  );
  const repeated = await connection.call<PRReviewRequestResult>(
    'prReview.submit',
    { request },
    { timeoutMs: 3_000 },
  );
  assert.equal(repeated.submission.id, receipt.submission.id);
  await assert.rejects(
    connection.call('prReview.submit', { request: { ...request, autoStart: false } }),
    /different review request/,
  );
  const deadline = Date.now() + 90_000;
  while (!receipt.submission.error && !receipt.intent?.queueItemId && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    receipt = await connection.call<PRReviewRequestResult>('prReview.get', {
      id: receipt.submission.id,
    });
  }
  if (expectError) {
    assert.match(receipt.submission.error ?? '', /unavailable/);
    assert.equal(receipt.intent?.runId, undefined);
  } else {
    assert.equal(receipt.submission.error, undefined);
    assert(receipt.intent?.queueItemId, 'Direct request must enter the shared queue');
    const { items } = await connection.call<{ items: QueueItem[] }>('dispatch.queue.list');
    const queued = items.find((item) => item.id === receipt?.intent?.queueItemId);
    assert(queued);
    assert.deepEqual(queued.allowedSlots, [slotId]);
    assert.equal(queued.reviewValidationDepth, 'full-live');
    assert.equal(queued.prWork?.review?.options.sessionIntent, 'resume');
    assert.equal(queued.model, 'gpt-6-astra');
    assert.equal(queued.effort, 'high');
    assert.equal(queued.runId, undefined);
  }
  const after = await observer.call<PRRulesListResult>('prRules.list');
  assert.equal(
    after.rules.length,
    before.rules.length,
    'Human intake must not create trigger rules',
  );
  assert(
    updates.some((state) => state.submissions?.some((item) => item.id === receipt?.submission.id)),
    'Second client must receive durable intake updates',
  );
  await cancel();
  const restarted = await client.call<PRReviewRequestResult>('prReview.get', {
    id: receipt.submission.id,
  });
  assert(restarted.submission.cancelledAt, 'Cancellation must survive reconnect');
  const cancelledReplay = await connection.call<PRReviewRequestResult>('prReview.submit', {
    request,
  });
  assert.equal(cancelledReplay.submission.cancelledAt, restarted.submission.cancelledAt);
  console.log(
    JSON.stringify({
      passed: true,
      durableReceipt: true,
      replay: true,
      noSyntheticRule: true,
      broadcast: true,
      cancellation: true,
      ...(expectError
        ? { providerFailure: true }
        : { sharedQueue: true, liveQAPolicy: true, selectedExecution: true }),
    }),
  );
} finally {
  try {
    if (receipt) await cancel();
  } finally {
    connection.close();
    observer.close();
  }
}

async function cancel(): Promise<void> {
  assert(receipt);
  for (let attempt = 0; attempt < 4; attempt++) {
    const current = await connection.call<PRReviewRequestResult>('prReview.get', {
      id: receipt.submission.id,
    });
    if (current.submission.cancelledAt) break;
    try {
      await connection.call('prReview.cancel', {
        id: current.submission.id,
        revision: current.submission.revision,
      });
      break;
    } catch (error) {
      // Provider completion can advance the receipt between get/cancel; retry only that version conflict.
      if (attempt === 3 || !(error instanceof Error) || !error.message.includes('changed'))
        throw error;
    }
  }
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const { items } = await connection.call<{ items: QueueItem[] }>('dispatch.queue.list');
    if (!items.some((item) => item.prWork?.sourceId === receipt?.intent?.id)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.fail('Cancelled request left queued work behind');
}
