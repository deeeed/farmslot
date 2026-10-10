import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { GatewayClient } from '../gateway-client.js';
import { resolveGatewayTarget } from '../gateway-profiles.js';

import { loadCheckoutEnv, parseEnvFile } from './env-file.js';

test('parseEnvFile handles comments, quotes, export, and tilde', () => {
  const parsed = parseEnvFile(
    [
      '# a comment',
      '',
      'GATEWAY_PORT=7801',
      'export GW_URL=ws://localhost:7801',
      'FARMSLOT_HOME=~/.farmslot-dev',
      'QUOTED="a b"',
      "SINGLE='x'",
      'not a valid line',
      '=novalue',
    ].join('\n'),
  );
  assert.equal(parsed.GATEWAY_PORT, '7801');
  assert.equal(parsed.GW_URL, 'ws://localhost:7801');
  assert.equal(parsed.FARMSLOT_HOME, '~/.farmslot-dev'); // left literal — the resolver expands ~
  assert.equal(parsed.QUOTED, 'a b');
  assert.equal(parsed.SINGLE, 'x');
  assert.equal(parsed['not a valid line'], undefined);
});

test('loadCheckoutEnv fills from .env.ports but never overrides the shell', () => {
  const root = mkdtempSync(join(tmpdir(), 'fs-envfile-'));
  writeFileSync(
    join(root, '.env.ports'),
    'FARMSLOT_HOME=~/.farmslot-dev\nGW_URL=ws://localhost:7801\n',
  );
  try {
    const env: NodeJS.ProcessEnv = { GW_URL: 'ws://localhost:9999' }; // shell already set GW_URL
    loadCheckoutEnv(root, env);
    assert.equal(env.FARMSLOT_HOME, '~/.farmslot-dev'); // filled from file
    assert.equal(env.GW_URL, 'ws://localhost:9999'); // shell wins, not overridden
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('loadCheckoutEnv derives GW_URL from GATEWAY_PORT when not explicitly configured', () => {
  const root = mkdtempSync(join(tmpdir(), 'fs-envfile-'));
  writeFileSync(join(root, '.env.ports'), 'GATEWAY_PORT=7801\nFARMSLOT_HOME=~/.farmslot-dev\n');
  try {
    const env: NodeJS.ProcessEnv = {};
    loadCheckoutEnv(root, env);
    assert.equal(env.GATEWAY_PORT, '7801');
    assert.equal(env.GW_URL, 'ws://localhost:7801');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('loadCheckoutEnv keeps explicit GW_URL over derived GATEWAY_PORT target', () => {
  const root = mkdtempSync(join(tmpdir(), 'fs-envfile-'));
  writeFileSync(join(root, '.env.ports'), 'GATEWAY_PORT=7801\n');
  writeFileSync(join(root, '.env'), 'GW_URL=ws://localhost:9999\n');
  try {
    const env: NodeJS.ProcessEnv = {};
    loadCheckoutEnv(root, env);
    assert.equal(env.GW_URL, 'ws://localhost:9999');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('.env.ports takes precedence over .env (loaded first, non-override)', () => {
  const root = mkdtempSync(join(tmpdir(), 'fs-envfile-'));
  writeFileSync(join(root, '.env.ports'), 'FOO=from-ports\n');
  writeFileSync(join(root, '.env'), 'FOO=from-env\nBAR=only-in-env\n');
  try {
    const env: NodeJS.ProcessEnv = {};
    loadCheckoutEnv(root, env);
    assert.equal(env.FOO, 'from-ports');
    assert.equal(env.BAR, 'only-in-env');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('loadCheckoutEnv is a no-op when no env files exist', () => {
  const root = mkdtempSync(join(tmpdir(), 'fs-envfile-'));
  try {
    const env: NodeJS.ProcessEnv = {};
    loadCheckoutEnv(root, env);
    assert.deepEqual(env, {});
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a present-but-unreadable env file throws instead of being silently skipped', () => {
  const root = mkdtempSync(join(tmpdir(), 'fs-envfile-'));
  mkdirSync(join(root, '.env.ports')); // a dir where a file is expected → read throws EISDIR, not ENOENT
  try {
    assert.throws(() => loadCheckoutEnv(root, {}), /cannot read/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a checkout .env gateway secret reaches only loopback targets, never a remote GW_URL', () => {
  const root = mkdtempSync(join(tmpdir(), 'fs-envfile-secret-'));
  writeFileSync(
    join(root, '.env'),
    'FARMSLOT_HOME=~/.farmslot-dev\nFARMSLOT_GATEWAY_TOKEN=file-secret\n',
  );
  const saved = {
    cwd: process.cwd(),
    token: process.env.FARMSLOT_GATEWAY_TOKEN,
    password: process.env.FARMSLOT_GATEWAY_PASSWORD,
  };
  delete process.env.FARMSLOT_GATEWAY_TOKEN;
  delete process.env.FARMSLOT_GATEWAY_PASSWORD;
  try {
    const env: NodeJS.ProcessEnv = { FARMSLOT_GATEWAY_PASSWORD: 'shell-secret' };
    loadCheckoutEnv(root, env);
    assert.equal(env.FARMSLOT_HOME, '~/.farmslot-dev');
    assert.equal(env.FARMSLOT_GATEWAY_TOKEN, undefined); // stays in its file
    assert.equal(env.FARMSLOT_GATEWAY_PASSWORD, 'shell-secret'); // the shell still wins

    const fileEnv: NodeJS.ProcessEnv = {};
    loadCheckoutEnv(root, fileEnv);
    assert.throws(
      () => resolveGatewayTarget({}, { ...fileEnv, GW_URL: 'ws://remote:7801' }, { gateways: {} }),
      /No stored gateway profile/,
    );

    // Loopback targets still discover the same file through the cwd chain.
    process.chdir(root);
    writeFileSync(join(root, '.env.ports'), 'GATEWAY_PORT=7801\n');
    const sandboxEnv: NodeJS.ProcessEnv = {};
    loadCheckoutEnv(root, sandboxEnv);
    const local = resolveGatewayTarget({}, sandboxEnv, { gateways: {} });
    const client = new GatewayClient({
      url: local.url,
      timeout: 1000,
      credential: local.credential,
    });
    assert.deepEqual(Reflect.get(client, 'credential'), { token: 'file-secret' });
  } finally {
    process.chdir(saved.cwd);
    if (saved.token !== undefined) process.env.FARMSLOT_GATEWAY_TOKEN = saved.token;
    if (saved.password !== undefined) process.env.FARMSLOT_GATEWAY_PASSWORD = saved.password;
    rmSync(root, { recursive: true, force: true });
  }
});

test('checkout-derived sandbox URLs remain usable without a stored profile, inherited worker URLs refuse', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fs-env-sandbox-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, '.env.ports'), 'GATEWAY_PORT=8808\n');
  const local: NodeJS.ProcessEnv = {};
  loadCheckoutEnv(root, local);
  assert.deepEqual(resolveGatewayTarget({}, local, { gateways: {} }), {
    url: 'ws://localhost:8808',
    source: 'env',
  });
  const worker: NodeJS.ProcessEnv = { GW_URL: 'ws://localhost:8808' };
  loadCheckoutEnv(root, worker);
  assert.throws(
    () => resolveGatewayTarget({}, worker, { gateways: {} }),
    /No stored gateway profile/,
  );
});

test('malformed checkout-derived gateway URL names the configuration variable', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fs-env-bad-gateway-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, '.env.ports'), 'GW_URL=not-a-url\n');
  const local: NodeJS.ProcessEnv = {};
  loadCheckoutEnv(root, local);
  assert.throws(
    () => resolveGatewayTarget({}, local, { gateways: {} }),
    /Invalid checkout-derived GW_URL/,
  );
});
