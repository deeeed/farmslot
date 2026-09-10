import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { GatewayClient } from '../packages/cli/src/gateway-client.js';
import { loadCheckoutEnv } from '../packages/cli/src/onboarding/env-file.js';
import {
  parseGitHubPullUrl,
  type PRRulePreviewResult,
  type PRRulesListResult,
} from '../packages/protocol/src/index.js';
loadCheckoutEnv(fileURLToPath(new URL('../', import.meta.url)));
const id = process.env.PR_RULE_VALIDATION_ID;
assert(
  id && process.env.PR_TARGET_URL,
  'Supply a disabled validation rule and an accessible PR URL',
);
const parsed = parseGitHubPullUrl(process.env.PR_TARGET_URL);
assert(parsed && new URL(process.env.PR_TARGET_URL).hostname === 'github.com');
const pr = { host: 'github.com', repo: parsed.repo, number: parsed.number };
const connection = await new GatewayClient({
  url: process.env.GW_URL ?? 'ws://127.0.0.1:7777',
  timeout: 120000,
}).connect();
try {
  const before = await connection.call<PRRulesListResult>('prRules.list', {});
  const rule = before.rules.find((rule) => rule.id === id);
  assert(
    rule && !rule.enabled && rule.config.name === 'Rule actions validation',
    'Use a disabled isolated rule',
  );
  const result = await connection.call<PRRulePreviewResult>('prRules.preview', { id, pr });
  assert(result.preview.complete, result.preview.sourceErrors.join('; '));
  assert.equal(
    result.preview.items.length,
    1,
    'A target preview must not enumerate unrelated repository PRs',
  );
  const item = result.preview.items[0];
  assert.equal(item.subject.pr.number, pr.number);
  assert.equal(item.subject.pr.repo.toLowerCase(), pr.repo.toLowerCase());
  assert(item.subject.headSha && item.subject.facts['head-branch']?.state === 'known');
  const after = await connection.call<PRRulesListResult>('prRules.list', {});
  assert.deepEqual(
    after.rules.find((rule) => rule.id === id),
    rule,
    'Target preview must not mutate rule lifecycle or full-source coverage',
  );
  assert.deepEqual(after.actions, before.actions);
  assert.deepEqual(after.intents, before.intents);
  console.log(
    JSON.stringify({
      passed: true,
      ruleId: id,
      targetOnly: true,
      headSha: item.subject.headSha,
      match: item.match.state,
      readOnly: true,
    }),
  );
} finally {
  connection.close();
}
