import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { GatewayClient } from '../packages/cli/src/gateway-client.js';
import type {
  PRRulesListResult,
  PRRulePreviewResult,
  PRTeamProfile,
  PRTeamSaveResult,
} from '../packages/protocol/src/index.js';

const id = process.env.POLICY_RULE_ID;
const backup = process.env.POLICY_BACKUP;
assert(id && backup, 'Supply POLICY_RULE_ID and a private POLICY_BACKUP file');
assert(['setup', 'verify', 'restore'].includes(process.argv[2]), 'Use setup, verify or restore');
const connection = await new GatewayClient({
  url: process.env.GW_URL ?? 'ws://127.0.0.1:7777',
  timeout: 120000,
}).connect();
try {
  const state = await connection.call<PRRulesListResult>('prRules.list', {});
  const rule = state.rules.find((rule) => rule.id === id);
  assert(rule && !rule.enabled, 'Use a disabled validation rule');
  const team = state.teams.find((team) => team.id === rule.config.teamId)!;
  assert(
    team.config.name.startsWith('Rule actions validation'),
    'Only reuse an existing isolated validation team',
  );
  if (process.argv[2] === 'restore') {
    const original = JSON.parse(await readFile(backup, 'utf8')) as PRTeamProfile;
    assert.equal(original.id, team.id);
    await connection.call('prRules.teamSave', {
      id: team.id,
      revision: team.revision,
      config: original.config,
    });
  } else {
    if (process.argv[2] === 'setup') {
      await writeFile(backup, JSON.stringify(team), { flag: 'wx', mode: 0o600 });
      const { team: updated } = await connection.call<PRTeamSaveResult>('prRules.teamSave', {
        id: team.id,
        revision: team.revision,
        config: {
          ...team.config,
          repositories: team.config.repositories.map((policy) => ({
            ...policy,
            approvalTarget: 1,
            staleAfterDays: 3,
          })),
        },
      });
      assert(updated.config.repositories.length);
    }
    const pr = {
      host: team.config.account.host,
      repo: team.config.repositories[0].repo,
      number: Number(process.env.POLICY_PR_NUMBER),
    };
    assert(Number.isSafeInteger(pr.number) && pr.number > 0);
    const { preview } = await connection.call<PRRulePreviewResult>('prRules.preview', { id, pr });
    assert(preview.complete, preview.sourceErrors.join('; '));
    assert.equal(preview.items.length, 1);
    const item = preview.items[0];
    assert.equal(typeof item.subject.reviewPolicyFacts?.approvalCount, 'number');
    assert(item.policySummary?.some((line) => /^Supplemental approvals: \d+\/1 /.test(line)));
    assert(item.policySummary?.some((line) => /^Activity: (inactive|recent)/.test(line)));
    assert(item.policySummary?.some((line) => line.startsWith('GitHub review requirement:')));
    const after = await connection.call<PRRulesListResult>('prRules.list', {});
    assert.equal(after.intents.length, state.intents.length, 'Preview must not create work');
    assert.equal(after.rules.find((rule) => rule.id === id)?.enabled, false);
    console.log(
      JSON.stringify({ passed: true, teamId: team.id, ruleId: id, summary: item.policySummary }),
    );
  }
} finally {
  connection.close();
}
