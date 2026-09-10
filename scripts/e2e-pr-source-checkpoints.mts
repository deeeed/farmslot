import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { utimes } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { GatewayClient } from '../packages/cli/src/gateway-client.js';
import { loadCheckoutEnv } from '../packages/cli/src/onboarding/env-file.js';
import type {
  PRRulePreviewResult,
  PRRuleSaveResult,
  PRRulesListResult,
  PRTeamSaveResult,
} from '../packages/protocol/src/index.js';

loadCheckoutEnv(fileURLToPath(new URL('../', import.meta.url)));
const gatewayUrl = process.env.GW_URL ?? 'ws://127.0.0.1:7777';
const url = new URL(gatewayUrl);
assert(
  ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname),
  'Run against the checkout-local validation gateway',
);
const repo = process.env.CHECKPOINT_REPO;
const login = process.env.CHECKPOINT_GITHUB_LOGIN;
assert(
  repo && login,
  'Supply a repository with enough open PRs to require more than 25 source requests',
);
const client = new GatewayClient({ url: gatewayUrl, timeout: 120_000 });
let connection = await client.connect();
const token = randomUUID();
let closed = false;
connection.onClose(() => {
  closed = true;
});
const { team } = await connection.call<PRTeamSaveResult>('prRules.teamSave', {
  config: {
    name: `Source checkpoint validation ${token}`,
    account: { host: 'github.com', login },
    sources: [{ kind: 'repository', repo }],
    repositories: [],
    githubTeams: [],
    notificationPrincipalIds: [],
    predicate: { kind: 'compare', field: 'state', operator: 'equals', value: 'open' },
  },
});
const { rule } = await connection.call<PRRuleSaveResult>('prRules.ruleSave', {
  config: {
    name: 'Source checkpoint validation',
    teamId: team.id,
    predicate: {
      kind: 'compare',
      field: 'changed-paths',
      operator: 'contains-any',
      value: ['.source-checkpoint-validation-only'],
    },
    actions: [{ kind: 'notify' }],
    maxAdmissionsPerScan: 1,
    pollIntervalMs: 300_000,
    rereviewOnHeadChange: true,
  },
});
assert.equal(rule.enabled, false);
async function listenerPid(): Promise<string> {
  try {
    return (
      await promisify(execFile)('lsof', ['-t', `-iTCP:${url.port || 80}`, '-sTCP:LISTEN'])
    ).stdout.trim();
  } catch (error) {
    if ((error as { code?: number }).code === 1) return ''; // No listener is expected briefly during restart.
    throw error;
  }
}
try {
  let result = await connection.call<PRRulePreviewResult>('prRules.preview', { id: rule.id });
  const first = result.preview.sourceProgress;
  assert(
    first &&
      !result.preview.complete &&
      first.requestsThisAttempt === 25 &&
      first.pendingConnections > 0,
    'First pass must stop at the request budget with durable continuation',
  );
  const before = await listenerPid();
  assert(before, 'Gateway listener must exist before restart validation');
  // Trigger the existing development watcher without altering source content or manually killing the gateway.
  await utimes(
    fileURLToPath(new URL('../services/gateway/src/methods/pr-rules.ts', import.meta.url)),
    new Date(),
    new Date(),
  );
  const deadline = Date.now() + 60_000;
  let restarted = false;
  while (Date.now() < deadline) {
    const current = await listenerPid();
    if (closed && current && current !== before) {
      restarted = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert(
    restarted,
    'Gateway process restart must be observed through listener identity and socket closure',
  );
  connection = await client.connect();
  let attempts = 1;
  while (!result.preview.complete && attempts < 10) {
    result = await connection.call<PRRulePreviewResult>('prRules.preview', { id: rule.id });
    attempts++;
    assert.equal(
      result.preview.sourceProgress?.id,
      first.id,
      'Restart must resume the same traversal generation',
    );
    assert((result.preview.sourceProgress?.requestsThisAttempt ?? Infinity) <= 25);
  }
  assert(result.preview.complete, result.preview.sourceErrors.join('; '));
  assert(
    (result.preview.sourceProgress?.pages ?? 0) > 25,
    'All pages must be collected across attempts',
  );
  const retained = await connection.call<PRRulePreviewResult>('prRules.preview', { id: rule.id });
  assert.equal(retained.preview.sourceProgress?.id, first.id);
  assert.equal(
    retained.preview.sourceProgress?.requestsThisAttempt,
    0,
    'Completed preview must survive until a consumer records it',
  );
  const inventory = await connection.call<PRRulesListResult>('prRules.list', {});
  assert.equal(inventory.rules.find((item) => item.id === rule.id)?.enabled, false);
  assert.equal(inventory.actions?.filter((action) => action.ruleId === rule.id).length, 0);
  assert(
    !inventory.intents.some((intent) =>
      intent.contributions.some((source) => source.ruleId === rule.id),
    ),
  );
  console.log(
    JSON.stringify({
      passed: true,
      ruleId: rule.id,
      teamId: team.id,
      teamName: team.config.name,
      attempts,
      pages: result.preview.sourceProgress?.pages,
      restarted: true,
      completedPreviewRetained: true,
      noActions: true,
    }),
  );
} finally {
  connection.close();
}
