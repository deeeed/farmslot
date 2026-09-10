#!/usr/bin/env tsx
// Creates a disabled draft through real RPCs, then verifies explicit browser mapping and activation gating.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { GatewayClient } from '../packages/cli/src/gateway-client.js';
import { loadCheckoutEnv } from '../packages/cli/src/onboarding/env-file.js';
import {
  compilePRProjectFilter,
  type PRRulesListResult,
  type PRRuleSaveResult,
  type PRTeamSaveResult,
  type PRRulePreviewResult,
} from '../packages/protocol/src/index.js';

loadCheckoutEnv(fileURLToPath(new URL('../', import.meta.url)));
const prefix = process.env.PROJECT_MAPPING_PREFIX;
const login = process.env.PROJECT_MAPPING_GITHUB_LOGIN;
const phase = process.argv[2];
assert(
  prefix && login && ['setup', 'mapped'].includes(phase),
  'Set PROJECT_MAPPING_PREFIX, PROJECT_MAPPING_GITHUB_LOGIN and use setup or mapped',
);
const client = new GatewayClient({
  url: process.env.GW_URL ?? 'ws://127.0.0.1:7777',
  timeout: 30_000,
});
const connection = await client.connect();
try {
  let state = await connection.call<PRRulesListResult>('prRules.list');
  if (phase === 'setup') {
    assert(
      !state.teams.some((team) => team.config.name === prefix),
      'Use a unique validation team name',
    );
    const { team } = await connection.call<PRTeamSaveResult>('prRules.teamSave', {
      config: {
        name: prefix,
        account: { host: 'github.com', login },
        sources: [
          {
            kind: 'github-project',
            projectId: 'PVT_validation-unavailable',
            label: 'Mapping validation',
            importedView: {
              number: 1,
              name: 'Open PRs',
              filter: "is:'open'",
              terms: compilePRProjectFilter("is:'open'", 'PVT_validation-unavailable', []),
            },
          },
        ],
        predicate: { kind: 'compare', field: 'state', operator: 'equals', value: 'open' },
        repositories: [],
        githubTeams: [],
        notificationPrincipalIds: [],
      },
    });
    const { rule } = await connection.call<PRRuleSaveResult>('prRules.ruleSave', {
      config: {
        name: prefix,
        teamId: team.id,
        predicate: team.config.predicate,
        actions: [{ kind: 'notify' }],
        pollIntervalMs: 300_000,
        maxAdmissionsPerScan: 1,
        rereviewOnHeadChange: true,
      },
    });
    const result = await connection.call<PRRulePreviewResult>('prRules.preview', { id: rule.id });
    assert.equal(result.preview.complete, false);
    assert.match(result.preview.sourceErrors.join('; '), /map is:'open' before enabling/);
    await assert.rejects(
      connection.call('prRules.setEnabled', {
        id: rule.id,
        revision: rule.revision,
        enabled: true,
        backfill: false,
      }),
      /map is:'open' before enabling/,
    );
    state = await connection.call<PRRulesListResult>('prRules.list');
  } else {
    const team = state.teams.find((team) => team.config.name === prefix);
    assert(team && team.revision === 2, 'The browser must save the existing team once');
    assert.equal(team.config.sources.length, 1, 'Mapping cannot add a broader repository source');
    const source = team.config.sources[0];
    assert(source.kind === 'github-project');
    assert.equal(source.projectId, 'PVT_validation-unavailable');
    assert.equal(source.importedView?.filter, "is:'open'");
    assert.deepEqual(source.importedView?.terms, [
      {
        text: "is:'open'",
        kind: 'predicate',
        manuallyMapped: true,
        predicate: { kind: 'compare', field: 'state', operator: 'equals', value: 'open' },
      },
    ]);
    const rule = state.rules.find((rule) => rule.config.teamId === team.id);
    assert(rule && !rule.enabled);
    await assert.rejects(
      connection.call('prRules.setEnabled', {
        id: rule.id,
        revision: rule.revision,
        enabled: true,
        backfill: false,
      }),
      /unavailable in the gateway keyring/,
    );
  }
  const rule = state.rules.find((rule) => rule.config.name === prefix);
  assert(rule && !rule.enabled);
  assert(!state.actions?.some((action) => action.ruleId === rule.id));
  console.log(JSON.stringify({ passed: true, phase, ruleId: rule.id, noAction: true }));
} finally {
  connection.close();
}
