#!/usr/bin/env tsx
// Real gateway validation. Uses held review intake and leaves its rule disabled.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { GatewayClient } from '../packages/cli/src/gateway-client.js';
import { loadCheckoutEnv } from '../packages/cli/src/onboarding/env-file.js';
import type {
  FleetStatus,
  QueueItem,
  PRRulePreviewResult,
  PRRulesListResult,
  PRRuleSaveResult,
  PRTeamSaveResult,
  PRTriggerRule,
} from '../packages/protocol/src/index.js';

loadCheckoutEnv(fileURLToPath(new URL('../', import.meta.url)));
const repo = process.env.RULE_REPOSITORY;
const login = process.env.RULE_GITHUB_LOGIN;
const project = process.env.RULE_PROJECT;
const slotId = process.env.RULE_SLOT;
assert(
  Boolean(project) === Boolean(slotId),
  'RULE_PROJECT and RULE_SLOT must be supplied together',
);
assert(
  repo && login,
  'Set RULE_REPOSITORY and RULE_GITHUB_LOGIN to a repository with open PRs and a gateway keyring account',
);
const client = new GatewayClient({
  url: process.env.GW_URL ?? 'ws://127.0.0.1:7777',
  timeout: 120_000,
});
const connection = await client.connect();
let rule: PRTriggerRule | undefined;
try {
  if (slotId) {
    const { fleet } = await connection.call<{ fleet: FleetStatus }>('fleet.status');
    const slot = fleet.slots.find((item) => item.slot === slotId && item.project === project);
    assert(
      slot && (!slot.enabled || !slot.dispatchable),
      'Dispatch validation requires a configured, non-dispatchable slot so no worker can launch',
    );
  }
  const initial = await connection.call<PRRulesListResult>('prRules.list');
  const previousTeam = initial.teams.find(
    (item) => item.config.name === 'PR rule gateway validation',
  );
  assert(
    !initial.rules.some((item) => item.enabled && item.config.teamId === previousTeam?.id),
    'Validation profile has an enabled rule; do not overwrite it',
  );
  const { team } = await connection.call<PRTeamSaveResult>('prRules.teamSave', {
    id: previousTeam?.id,
    revision: previousTeam?.revision,
    config: {
      name: 'PR rule gateway validation',
      account: { host: 'github.com', login },
      sources: [{ kind: 'repository', repo }],
      predicate: { kind: 'compare', field: 'state', operator: 'equals', value: 'open' },
      repositories: project
        ? [{ repo, project, reviewProfile: 'validation-held', excludedLabels: [] }]
        : [],
      ...(slotId
        ? {
            execution: {
              slotPolicy: { kind: 'exact', slotId },
              models: [{ runner: 'codex', model: 'gpt-6-astra', effort: 'high' }],
            },
          }
        : {}),
      githubTeams: [],
      review: { sessionIntent: 'resume', scope: 'incremental', validationDepth: 'full-live' },
      notificationPrincipalIds: [],
    },
  });
  const previousRule = initial.rules.find(
    (item) => item.config.teamId === team.id && item.config.name === 'Held review validation',
  );
  ({ rule } = await connection.call<PRRuleSaveResult>('prRules.ruleSave', {
    id: previousRule?.id,
    revision: previousRule?.revision,
    config: {
      name: 'Held review validation',
      teamId: team.id,
      predicate: { kind: 'compare', field: 'draft', operator: 'equals', value: false },
      actions: [{ kind: 'review', autoStart: false }],
      pollIntervalMs: 300_000,
      maxAdmissionsPerScan: 1,
      rereviewOnHeadChange: true,
    },
  }));
  assert.equal(rule.enabled, false);
  const before = await connection.call<PRRulesListResult>('prRules.list');
  const { preview } = await connection.call<PRRulePreviewResult>('prRules.preview', {
    id: rule.id,
  });
  assert.equal(preview.complete, true, preview.sourceErrors.join('; '));
  assert(
    preview.items.some((item) => item.match.state === 'match'),
    'Repository needs an eligible non-draft PR',
  );
  assert.deepEqual(
    await connection.call('prRules.list'),
    before,
    'Preview must not write durable rule or queue state',
  );
  ({ rule } = await connection.call<PRRuleSaveResult>('prRules.setEnabled', {
    id: rule.id,
    revision: rule.revision,
    enabled: true,
    backfill: false,
  }));
  await connection.call('prRules.scan', { id: rule.id });
  const baseline = await connection.call<PRRulesListResult>('prRules.list');
  assert(
    !baseline.intents.some((item) =>
      item.contributions.some((source) => source.ruleId === rule?.id && source.eligible),
    ),
    'Activation without backfill must not admit historical matches',
  );
  ({ rule } = await connection.call<PRRuleSaveResult>('prRules.setEnabled', {
    id: rule.id,
    revision: rule.revision,
    enabled: true,
    backfill: true,
  }));
  const admitted = await connection.call<PRRulesListResult>('prRules.list');
  const active = admitted.intents.filter((item) =>
    item.contributions.some((source) => source.ruleId === rule?.id && source.eligible),
  );
  assert.equal(active.length, 1);
  assert.equal(active[0].status, project ? 'held' : 'needs-configuration');
  assert(!active[0].queueItemId && !active[0].runId);
  await connection.call('prRules.scan', { id: rule.id });
  const reconnect = await client.call<PRRulesListResult>('prRules.list');
  assert.equal(reconnect.intents.filter((item) => item.id === active[0].id).length, 1);
  if (slotId) {
    await connection.call('prRules.accept', { id: active[0].id });
    let queued: QueueItem | undefined;
    const deadline = Date.now() + 30_000;
    while (!queued && Date.now() < deadline) {
      const { items } = await connection.call<{ items: QueueItem[] }>('dispatch.queue.list');
      queued = items.find((item) => item.prWork?.sourceId === active[0].id);
      if (!queued) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert(queued, 'Accepted review must enter the existing dispatch queue');
    assert.equal(queued.status, 'queued');
    assert.deepEqual(queued.allowedSlots, [slotId]);
    assert.equal(queued.model, 'gpt-6-astra');
    assert.equal(queued.effort, 'high');
    assert.equal(queued.reviewValidationDepth, 'full-live');
    assert.deepEqual(queued.prWork?.review?.options, {
      sessionIntent: 'resume',
      scope: 'incremental',
      validationDepth: 'full-live',
    });
    assert.equal(queued.runId, undefined);
    await connection.call('prRules.defer', { id: active[0].id });
    let removed = false;
    const removalDeadline = Date.now() + 30_000;
    while (!removed && Date.now() < removalDeadline) {
      const { items } = await connection.call<{ items: QueueItem[] }>('dispatch.queue.list');
      removed = !items.some((item) => item.id === queued?.id);
      if (!removed) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert(removed, 'Deferring must withdraw unstarted dispatch work');
  }
  console.log(
    JSON.stringify({
      passed: true,
      previewReadOnly: true,
      baselineWithoutBackfill: true,
      explicitBackfill: true,
      heldWithoutMapping: true,
      replayDeduplicated: true,
      ...(slotId
        ? { pinnedDispatchQueued: true, modelEffortPreserved: true, deferWithdrawsQueue: true }
        : {}),
    }),
  );
} finally {
  try {
    if (rule) {
      const current = (await connection.call<PRRulesListResult>('prRules.list')).rules.find(
        (item) => item.id === rule?.id,
      );
      if (current?.enabled)
        await connection.call('prRules.setEnabled', {
          id: current.id,
          revision: current.revision,
          enabled: false,
          backfill: false,
        });
    }
  } finally {
    connection.close();
  }
}
