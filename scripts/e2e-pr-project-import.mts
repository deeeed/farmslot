#!/usr/bin/env tsx
// Read-only import validation; the API must not persist team/rule configuration or work.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { GatewayClient } from '../packages/cli/src/gateway-client.js';
import { loadCheckoutEnv } from '../packages/cli/src/onboarding/env-file.js';
import {
  assertPRImportedProjectView,
  parsePRProjectURL,
  type PRProjectImportResult,
  type PRRulesListResult,
  type PRWatchListResult,
} from '../packages/protocol/src/index.js';

loadCheckoutEnv(fileURLToPath(new URL('../', import.meta.url)));
const url = process.env.PROJECT_IMPORT_URL;
const login = process.env.PROJECT_IMPORT_LOGIN;
const host = process.env.PROJECT_IMPORT_HOST ?? 'github.com';
assert(url && login, 'Set PROJECT_IMPORT_URL and PROJECT_IMPORT_LOGIN');
const expected = parsePRProjectURL(url, host);
const client = new GatewayClient({
  url: process.env.GW_URL ?? 'ws://127.0.0.1:7777',
  timeout: 120_000,
});
const connection = await client.connect();
try {
  const before = await connection.call<PRRulesListResult>('prRules.list');
  const watches = await connection.call<PRWatchListResult>('prWatch.list');
  if (process.env.PROJECT_EXPECT_ACCESS_ERROR === '1') {
    await assert.rejects(
      connection.call('prRules.projectImport', { account: { host, login }, url }),
      /read:project|INSUFFICIENT_SCOPES|rate limit|query budget/i,
      'Unavailable Project access or quota must be explicit',
    );
  } else {
    const result = await connection.call<PRProjectImportResult>('prRules.projectImport', {
      account: { host, login },
      url,
    });
    assert.equal(result.source.kind, 'github-project');
    assert.equal(result.source.projectId, result.project.id);
    assert.equal(result.source.url, result.project.url);
    assert.equal(result.source.importedView?.number, expected.viewNumber);
    if (expected.viewNumber) {
      assert(result.source.importedView);
      assertPRImportedProjectView(result.source.importedView);
    }
    assert(
      result.project.fields.length,
      'The Project catalog must expose actual field definitions',
    );
    console.log(
      JSON.stringify({
        projectId: result.project.id,
        fields: result.project.fields.length,
        terms: result.source.importedView?.terms.length ?? 0,
        unmapped:
          result.source.importedView?.terms.filter((term) => term.kind === 'unmapped').length ?? 0,
      }),
    );
  }
  const after = await connection.call<PRRulesListResult>('prRules.list');
  assert.deepEqual(after.teams, before.teams, 'Import is a draft, not a saved team');
  assert.deepEqual(after.rules, before.rules, 'Import cannot enable or create rules');
  assert.deepEqual(after.intents, before.intents, 'Import cannot admit work');
  assert.equal(
    (await connection.call<PRWatchListResult>('prWatch.list')).monitors.length,
    watches.monitors.length,
    'Import cannot enroll monitoring',
  );
  console.log(
    JSON.stringify({
      passed: true,
      noMutation: true,
      ...(process.env.PROJECT_EXPECT_ACCESS_ERROR === '1' ? { accessFailureExplicit: true } : {}),
    }),
  );
} finally {
  connection.close();
}
