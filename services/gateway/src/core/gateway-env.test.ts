import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createGatewayAuthRuntime } from '../security/auth.js';

import { loadGatewayEnvFiles } from './gateway-env.js';

test('gateway checkout reload cannot replace the isolated sandbox home with an activated host store', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'gateway-env-home-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const host = path.join(root, 'host');
  const sandbox = path.join(root, 'runtime/home');
  mkdirSync(host);
  mkdirSync(sandbox, { recursive: true });
  const store = JSON.stringify({
    schemaVersion: 1,
    activatedAt: '2026-10-10T00:00:00.000Z',
    principals: [],
    credentials: [],
  });
  writeFileSync(path.join(host, 'credentials.json'), store);
  writeFileSync(path.join(root, '.env'), `FARMSLOT_HOME=${host}\n`);
  writeFileSync(path.join(root, '.env.local-auth'), '');
  const env = { GATEWAY_HOST: '127.0.0.1', FARMSLOT_HOME: sandbox, FARMSLOT_SANDBOX_HOME: sandbox };
  loadGatewayEnvFiles(root, env);
  const runtime = createGatewayAuthRuntime(env);
  assert.equal(env.FARMSLOT_HOME, sandbox);
  assert.equal(runtime.store.path, path.join(sandbox, 'credentials.json'));
  assert.equal(runtime.resolver.isSoloMode(), true);
  assert.equal(readFileSync(path.join(host, 'credentials.json'), 'utf8'), store);

  const operatorEnv = { GATEWAY_HOST: '127.0.0.1', FARMSLOT_HOME: sandbox };
  loadGatewayEnvFiles(root, operatorEnv);
  assert.equal(operatorEnv.FARMSLOT_HOME, host);
  assert.equal(createGatewayAuthRuntime(operatorEnv).resolver.isSoloMode(), false);
});

test('an unreadable checkout configuration stops startup before credential selection', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'gateway-env-unreadable-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, '.env'));
  assert.throws(() => loadGatewayEnvFiles(root, {}), /Cannot load gateway configuration.*EISDIR/);
});
