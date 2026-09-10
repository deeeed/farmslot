#!/usr/bin/env tsx
// Gateway assertions for the real Command Center team/rule authoring recipe.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { GatewayClient } from '../packages/cli/src/gateway-client.js';
import { loadCheckoutEnv } from '../packages/cli/src/onboarding/env-file.js';
import type { FleetStatus, PRRulesListResult } from '../packages/protocol/src/index.js';

loadCheckoutEnv(fileURLToPath(new URL('../', import.meta.url)));
const phase = process.argv[2];
assert(
  [
    'before',
    'team',
    'team-edited',
    'rule',
    'rule-edited',
    'action-rule',
    'action-rule-edited',
    'concurrent-edit',
    'conflict',
  ].includes(phase),
);
const prefix = process.env.AUTHORING_PREFIX;
const repo = process.env.AUTHORING_REPO;
const project = process.env.AUTHORING_PROJECT;
const slotId = process.env.AUTHORING_SLOT;
const login = process.env.AUTHORING_GITHUB_LOGIN;
assert(
  prefix && repo && project && slotId && login,
  'Set AUTHORING_PREFIX, AUTHORING_REPO, AUTHORING_PROJECT, AUTHORING_SLOT and AUTHORING_GITHUB_LOGIN',
);
const client = new GatewayClient({
  url: process.env.GW_URL ?? 'ws://127.0.0.1:7777',
  timeout: 15_000,
});
const connection = await client.connect();
try {
  const state = await connection.call<PRRulesListResult>('prRules.list');
  const team = state.teams.find((item) => item.config.name === `${prefix} team`);
  const rule = state.rules.find((item) => item.config.name === `${prefix} rule`);
  if (phase === 'before') {
    assert(!team && !rule, 'Use a unique prefix; do not edit existing operator policies');
    const { fleet } = await connection.call<{ fleet: FleetStatus }>('fleet.status');
    assert(
      fleet.slots.some((slot) => slot.slot === slotId && slot.project === project && !slot.enabled),
      'Choose a disabled validation slot',
    );
  } else {
    assert(team, 'Browser must save a real team');
    assert.equal(team.config.account.login, login);
    assert.deepEqual(team.config.sources, [{ kind: 'repository', repo }]);
    assert.deepEqual(team.config.predicate, {
      kind: 'all',
      items: [{ kind: 'compare', field: 'state', operator: 'equals', value: 'open' }],
    });
    assert.deepEqual(team.config.execution?.slotPolicy, { kind: 'exact', slotId });
    assert.equal(team.config.execution?.models[0].model, 'gpt-6-astra');
    assert.equal(team.config.execution?.models[0].effort, 'high');
    assert.equal(team.config.review?.validationDepth, 'full-live');
    assert.equal(team.config.review?.sessionIntent, 'resume');
    assert.equal(team.config.repositories.length, 1);
    const policy = team.config.repositories[0];
    assert.equal(policy.repo, repo);
    assert.equal(policy.project, project);
    assert.equal(policy.reviewProfile, 'authoring-validation');
    assert.equal(policy.execution, undefined, 'Repository inherits team slots/models');
    if (phase === 'team') {
      assert.equal(team.revision, 1);
      assert.equal(policy.review, undefined, 'Repository initially inherits review settings');
    } else {
      assert.equal(team.revision, phase === 'conflict' ? 3 : 2, 'Editing updates the same team');
      assert.equal(policy.review?.sessionIntent, 'reset');
      assert.equal(
        policy.review?.validationDepth,
        'full-live',
        'Repository override starts from the inherited settings',
      );
      assert.deepEqual(policy.excludedLabels, ['skip-review']);
    }
    if (['rule', 'rule-edited', 'concurrent-edit', 'conflict'].includes(phase)) {
      assert(rule, 'Browser must save a real rule');
      assert.equal(rule.config.teamId, team.id);
      assert.equal(rule.enabled, false, 'Saving must not activate or backfill a rule');
      assert.equal(rule.config.pollIntervalMs, 120_000);
      assert.equal(rule.config.maxAdmissionsPerScan, phase === 'rule' ? 3 : 4);
      assert.equal(rule.revision, phase === 'rule' ? 1 : 2);
      assert.deepEqual(
        rule.config.actions,
        [{ kind: 'review', autoStart: false }],
        'Rule inherits repository and team policy and holds work for acceptance',
      );
      assert.deepEqual(rule.config.predicate, {
        kind: 'compare',
        field: 'state',
        operator: 'equals',
        value: 'open',
      });
      assert(
        !state.intents.some((intent) =>
          intent.contributions.some((source) => source.ruleId === rule.id),
        ),
        'Disabled authoring cannot admit review work',
      );
    }
    if (phase === 'concurrent-edit') {
      assert(rule && !rule.enabled, 'Only mutate the disabled rule validation team');
      await connection.call('prRules.teamSave', {
        id: team.id,
        revision: team.revision,
        config: { ...team.config, repositories: [{ ...policy, approvalTarget: 1 }] },
      });
    }
    if (phase === 'conflict')
      assert.equal(
        policy.approvalTarget,
        1,
        'A stale browser save cannot erase another client edit',
      );
    if (phase === 'action-rule' || phase === 'action-rule-edited') {
      const configured = state.rules.find((item) => item.config.name === `${prefix} actions`);
      assert(configured && !configured.enabled, 'Action rules also start disabled');
      assert.equal(configured.revision, phase === 'action-rule' ? 1 : 2);
      assert.deepEqual(configured.config.actions.map((action) => action.kind).sort(), [
        'monitor',
        'notify',
      ]);
      const monitor = configured.config.actions.find((action) => action.kind === 'monitor');
      assert(monitor);
      if (phase === 'action-rule') {
        assert.equal(monitor.policy.mode, 'automatic-repair');
        assert(monitor.policy.mode === 'automatic-repair');
        assert.deepEqual(monitor.policy.execution.slotPolicy, { kind: 'exact', slotId });
      } else assert.deepEqual(monitor.policy, { mode: 'notify-only' });
      assert(
        !state.actions?.some((action) => action.ruleId === configured.id),
        'Saving a disabled action rule cannot deliver notifications or subscriptions',
      );
      assert(
        !state.intents.some((intent) =>
          intent.contributions.some((source) => source.ruleId === configured.id),
        ),
        'No review action means no review intent',
      );
    }
  }
  console.log(JSON.stringify({ passed: true, phase, teamId: team?.id, ruleId: rule?.id }));
} finally {
  connection.close();
}
