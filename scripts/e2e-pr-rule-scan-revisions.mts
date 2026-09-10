#!/usr/bin/env tsx
// A real provider scan stays pending while a newer rule revision is activated and backfilled.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { GatewayClient } from '../packages/cli/src/gateway-client.js';
import { loadCheckoutEnv } from '../packages/cli/src/onboarding/env-file.js';
import type {
  PRRulesListResult,
  PRRuleSaveResult,
  PRTeamSaveResult,
  PRTriggerRule,
} from '../packages/protocol/src/index.js';
loadCheckoutEnv(fileURLToPath(new URL('../', import.meta.url)));
const repo = process.env.RULE_REPOSITORY,
  login = process.env.RULE_GITHUB_LOGIN;
assert(repo && login);
const client = new GatewayClient({
  url: process.env.GW_URL ?? 'ws://127.0.0.1:7777',
  timeout: 120_000,
});
const connection = await client.connect();
let rule: PRTriggerRule | undefined;
let oldScan: Promise<unknown> | undefined;
let oldFinished = false;
try {
  const { team } = await connection.call<PRTeamSaveResult>('prRules.teamSave', {
    config: {
      name: `Scan revision validation ${randomUUID()}`,
      account: { host: 'github.com', login },
      sources: [{ kind: 'repository', repo }],
      predicate: { kind: 'compare', field: 'state', operator: 'equals', value: 'open' },
      repositories: [],
      githubTeams: [],
      notificationPrincipalIds: [],
    },
  });
  rule = (
    await connection.call<PRRuleSaveResult>('prRules.ruleSave', {
      config: {
        name: 'Old scan revision',
        teamId: team.id,
        predicate: team.config.predicate,
        actions: [{ kind: 'notify' }],
        pollIntervalMs: 86_400_000,
        maxAdmissionsPerScan: 1,
        rereviewOnHeadChange: true,
      },
    })
  ).rule;
  oldScan = connection.call('prRules.scan', { id: rule.id }).finally(() => {
    oldFinished = true;
  });
  // Observe every outcome immediately, but retain failure for the awaited assertion below.
  const settledOld = Promise.allSettled([oldScan]);
  rule = (
    await connection.call<PRRuleSaveResult>('prRules.ruleSave', {
      id: rule.id,
      revision: rule.revision,
      config: { ...rule.config, name: 'Current scan revision' },
    })
  ).rule;
  assert(!oldFinished, 'The older source scan must still be pending when the rule edit completes');
  rule = (
    await connection.call<PRRuleSaveResult>('prRules.setEnabled', {
      id: rule.id,
      revision: rule.revision,
      enabled: true,
      backfill: true,
    })
  ).rule;
  let state = await connection.call<PRRulesListResult>('prRules.list');
  const current = state.actions?.filter((action) => action.ruleId === rule!.id) ?? [];
  assert.equal(
    current.length,
    1,
    rule.scan.error ?? 'Activation must finish backfill under its current revision',
  );
  assert.equal(current[0].ruleRevision, rule.revision);
  const oldResult = (await settledOld)[0];
  if (oldResult.status === 'rejected') throw oldResult.reason;
  state = await client.call<PRRulesListResult>('prRules.list');
  assert.deepEqual(
    state.actions?.filter((action) => action.ruleId === rule!.id),
    current,
    'An obsolete completed scan cannot replace current action receipts',
  );
} finally {
  try {
    if (oldScan) await Promise.allSettled([oldScan]);
    if (rule) {
      const current = (await connection.call<PRRulesListResult>('prRules.list')).rules.find(
        (item) => item.id === rule!.id,
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
console.log(
  JSON.stringify({
    passed: true,
    overlappingRevisions: true,
    currentBackfill: true,
    staleScanIgnored: true,
    ruleId: rule?.id,
  }),
);
