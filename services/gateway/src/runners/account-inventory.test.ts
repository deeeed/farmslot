import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { RunnerProviderAccount } from '@farmslot/protocol';

import { INVENTORY_SCRIPT, parsePiAuthCheck } from './account-inventory.js';

test('host probe preserves multiple providers and excludes credential values', (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'runner-accounts-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const authFile = path.join(directory, 'auth.json');
  const secret = 'PRIVATE-CREDENTIAL-SENTINEL';
  const spec = {
    directoryEnv: 'FARMSLOT_TEST_AUTH_DIR',
    defaultDirectory: [],
    suffix: [],
    apiKeyType: 'api_key',
  };
  const probe = (binary = process.execPath, extra = {}, env = {}) =>
    execFileSync(
      process.execPath,
      ['-e', INVENTORY_SCRIPT, JSON.stringify({ ...spec, ...extra }), binary],
      { env: { ...process.env, FARMSLOT_TEST_AUTH_DIR: directory, ...env }, encoding: 'utf8' },
    );
  assert.deepEqual(JSON.parse(probe()).accounts, []);
  writeFileSync(
    authFile,
    JSON.stringify({
      anthropic: { type: 'oauth', access: secret, refresh: secret, email: secret },
      xai: { type: 'api_key', key: secret },
    }),
  );
  const raw = probe();
  assert.ok(!raw.includes(secret));
  assert.deepEqual(
    JSON.parse(raw).accounts.map((a: RunnerProviderAccount) => [a.provider, a.authType, a.status]),
    [
      ['anthropic', 'oauth', 'configured'],
      ['xai', 'api_key', 'configured'],
    ],
  );
  assert.equal(JSON.parse(probe(path.join(directory, 'missing'))).status, 'unavailable');
  writeFileSync(authFile, JSON.stringify({ anthropic: { type: 'api', key: secret } }));
  assert.equal(
    JSON.parse(probe(process.execPath, { apiKeyType: 'api' })).accounts[0].authType,
    'api_key',
  );
  writeFileSync(authFile, `{invalid-${secret}`);
  const invalid = probe();
  assert.equal(JSON.parse(invalid).status, 'unavailable');
  assert.ok(!invalid.includes(secret));
  const content = probe(
    process.execPath,
    { contentEnv: 'FARMSLOT_TEST_AUTH_CONTENT', apiKeyType: 'api' },
    { FARMSLOT_TEST_AUTH_CONTENT: JSON.stringify({ openai: { type: 'api', key: secret } }) },
  );
  assert.deepEqual(
    JSON.parse(content).accounts.map((a: RunnerProviderAccount) => a.provider),
    ['openai'],
  );
  assert.ok(!content.includes(secret));
});

test('Pi readiness is provider-specific and does not relay unknown fields', () => {
  const account: RunnerProviderAccount = {
    id: 'anthropic',
    provider: 'anthropic',
    authType: 'oauth',
    status: 'configured',
    source: 'credential-store',
  };
  assert.equal(
    parsePiAuthCheck('{"provider":"anthropic","status":"invalid"}', account).status,
    'invalid',
  );
  const value = parsePiAuthCheck(
    JSON.stringify({
      provider: 'anthropic',
      status: 'ready',
      authType: 'oauth',
      access: 'SENTINEL',
    }),
    account,
  );
  assert.equal(value.status, 'ready');
  assert.equal(value.source, 'native-status');
  assert.ok(!JSON.stringify(value).includes('SENTINEL'));
  assert.throws(() =>
    parsePiAuthCheck('{"provider":"xai","status":"ready","authType":"oauth"}', account),
  );
  assert.throws(() => parsePiAuthCheck('{"provider":"anthropic","status":"ready"}', account));
  assert.equal(
    parsePiAuthCheck('{"provider":"anthropic","status":"not_ready"}', account).status,
    'not_ready',
  );
});
