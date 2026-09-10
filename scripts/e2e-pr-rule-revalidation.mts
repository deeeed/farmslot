#!/usr/bin/env tsx
// Proves edit baselines and pending-action budgets with real source reads and no execution mapping.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { GatewayClient } from '../packages/cli/src/gateway-client.js';
import { loadCheckoutEnv } from '../packages/cli/src/onboarding/env-file.js';
import type {
  FleetStatus,
  PRRuleSaveResult,
  PRRulesListResult,
  PRTeamSaveResult,
  PRTriggerRule,
  PRWatchListResult,
} from '../packages/protocol/src/index.js';

loadCheckoutEnv(fileURLToPath(new URL('../', import.meta.url)));
const repo = process.env.RULE_REPOSITORY;
const baselineRepo = process.env.RULE_BASELINE_REPOSITORY;
const login = process.env.RULE_GITHUB_LOGIN;
const slotId = process.env.RULE_SLOT;
assert(
  repo && baselineRepo && repo !== baselineRepo && login && slotId,
  'Set distinct RULE_REPOSITORY/RULE_BASELINE_REPOSITORY, RULE_GITHUB_LOGIN and a disabled RULE_SLOT',
);
const client = new GatewayClient({
  url: process.env.GW_URL ?? 'ws://127.0.0.1:7777',
  timeout: 120_000,
});
const connection = await client.connect();
let rule: PRTriggerRule | undefined;
let teamId: string | undefined;
try {
  const { fleet } = await connection.call<{ fleet: FleetStatus }>('fleet.status');
  assert(fleet.slots.some((slot) => slot.slot === slotId && !slot.enabled));
  let { team } = await connection.call<PRTeamSaveResult>('prRules.teamSave', {
    config: {
      name: `Rule revalidation ${randomUUID()}`,
      account: { host: 'github.com', login },
      sources: [{ kind: 'repository', repo: baselineRepo }],
      predicate: { kind: 'compare', field: 'state', operator: 'equals', value: 'open' },
      repositories: [],
      githubTeams: [],
      notificationPrincipalIds: [],
    },
  });
  teamId = team.id;
  rule = (
    await connection.call<PRRuleSaveResult>('prRules.ruleSave', {
      config: {
        name: 'Rule revalidation',
        teamId,
        predicate: { kind: 'compare', field: 'repository', operator: 'equals', value: repo },
        actions: [
          {
            kind: 'monitor',
            policy: {
              mode: 'automatic-repair',
              execution: {
                slotPolicy: { kind: 'exact', slotId },
                models: [{ runner: 'codex', model: 'gpt-6-astra', effort: 'high' }],
              },
            },
          },
        ],
        pollIntervalMs: 86_400_000,
        maxAdmissionsPerScan: 2,
        rereviewOnHeadChange: true,
      },
    })
  ).rule;
  rule = (
    await connection.call<PRRuleSaveResult>('prRules.setEnabled', {
      id: rule.id,
      revision: rule.revision,
      enabled: true,
      backfill: false,
    })
  ).rule;
  team = (
    await connection.call<PRTeamSaveResult>('prRules.teamSave', {
      id: team.id,
      revision: team.revision,
      config: { ...team.config, sources: [...team.config.sources, { kind: 'repository', repo }] },
    })
  ).team;
  await connection.call('prRules.scan', { id: rule.id });
  let state = await connection.call<PRRulesListResult>('prRules.list');
  assert.equal(
    state.actions?.filter((action) => action.ruleId === rule!.id).length ?? 0,
    0,
    'Source expansion cannot backfill historical PRs implicitly',
  );
  rule = (
    await connection.call<PRRuleSaveResult>('prRules.setEnabled', {
      id: rule.id,
      revision: rule.revision,
      enabled: true,
      backfill: true,
    })
  ).rule;
  assert(
    Object.values(rule.scan.subjects).filter((subject) => subject.matched).length > 2,
    'Choose a repository with at least three open PRs to exercise budget deferral',
  );
  state = await connection.call<PRRulesListResult>('prRules.list');
  let actions = state.actions?.filter((action) => action.ruleId === rule!.id) ?? [];
  assert.equal(actions.length, 2);
  assert(
    actions.every((action) => action.status === 'pending' && /project/i.test(action.error ?? '')),
    'Missing mappings retain actionable pending enrollment',
  );
  assert.match(rule.scan.admissionWarning ?? '', /limit/);
  rule = (
    await connection.call<PRRuleSaveResult>('prRules.ruleSave', {
      id: rule.id,
      revision: rule.revision,
      config: { ...rule.config, maxAdmissionsPerScan: 1 },
    })
  ).rule;
  await connection.call('prRules.scan', { id: rule.id });
  state = await client.call<PRRulesListResult>('prRules.list');
  actions = state.actions?.filter((action) => action.ruleId === rule!.id) ?? [];
  assert.equal(
    actions.filter((action) => action.status === 'pending' && action.current).length,
    2,
    'A lower limit must preserve previously admitted pending actions',
  );
  await connection.call('prRules.scan', { id: rule.id });
  state = await client.call<PRRulesListResult>('prRules.list');
  assert.match(
    state.rules.find((item) => item.id === rule!.id)?.scan.admissionWarning ?? '',
    /limit/,
    'Budget attention must survive unchanged scans and reconnect',
  );
  assert(
    !(await connection.call<PRWatchListResult>('prWatch.list')).monitors.some(
      (monitor) => monitor.config.teamId === teamId,
    ),
    'Missing project mappings cannot create subscriptions',
  );
} finally {
  try {
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
      assert(
        !(await connection.call<PRRulesListResult>('prRules.list')).actions?.some(
          (action) => action.ruleId === rule!.id && action.status === 'pending',
        ),
        'Disabling the rule withdraws pending validation work',
      );
    }
  } finally {
    connection.close();
  }
}
console.log(
  JSON.stringify({
    passed: true,
    sourceEditBaseline: true,
    pendingAdmissionPreserved: true,
    budgetAttentionPersists: true,
    noSubscription: true,
    withdrawn: true,
    ruleId: rule?.id,
  }),
);
