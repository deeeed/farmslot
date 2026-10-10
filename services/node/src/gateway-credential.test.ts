import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { findNodeTokenEnvFile, resolveGatewayCredential } from './gateway-credential.js';

test('gateway credential is re-read from the node env file on every reconnect lookup', () => {
  const root = mkdtempSync(join(tmpdir(), 'farmslot-node-credential-'));
  const nested = join(root, 'services', 'node');
  mkdirSync(nested, { recursive: true });
  const path = join(root, '.env.local-auth');
  writeFileSync(path, 'FARMSLOT_NODE_TOKEN=first\n');
  assert.deepEqual(resolveGatewayCredential({}, nested), { token: 'first' });

  writeFileSync(path, 'FARMSLOT_NODE_TOKEN=second\n');
  assert.deepEqual(resolveGatewayCredential({}, nested), { token: 'second' });
});

test('rewritten node env credential outranks stale inherited launch credentials', () => {
  const root = mkdtempSync(join(tmpdir(), 'farmslot-node-credential-stale-env-'));
  const nested = join(root, 'services', 'node');
  mkdirSync(nested, { recursive: true });
  const path = join(root, '.env.local-auth');
  const launchedEnv = {
    FARMSLOT_NODE_TOKEN: 'stale-node-token',
    FARMSLOT_GATEWAY_TOKEN: 'stale-gateway-token',
  };

  writeFileSync(path, 'FARMSLOT_NODE_TOKEN=first-file-token\n');
  assert.deepEqual(resolveGatewayCredential(launchedEnv, nested), { token: 'first-file-token' });

  writeFileSync(path, 'FARMSLOT_NODE_TOKEN=rotated-file-token\n');
  assert.deepEqual(resolveGatewayCredential(launchedEnv, nested), { token: 'rotated-file-token' });
});

const tempRoot = (t: TestContext, prefix: string) => {
  const root = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
};

test('the node token file is the first env file with a FARMSLOT_NODE_TOKEN, from the install dir up', (t) => {
  const root = tempRoot(t, 'farmslot-node-token-file-');
  const install = join(root, 'farmslot-node');
  mkdirSync(install);
  writeFileSync(join(root, '.env.local-auth'), 'FARMSLOT_NODE_TOKEN=ancestor-token\n');
  assert.deepEqual(findNodeTokenEnvFile({}, install), {
    path: join(root, '.env.local-auth'),
    token: 'ancestor-token',
  });

  writeFileSync(join(install, '.env'), 'export FARMSLOT_NODE_TOKEN="install-env-token"\n');
  assert.deepEqual(findNodeTokenEnvFile({}, install), {
    path: join(install, '.env'),
    token: 'install-env-token',
  });

  // .env.local-auth comes before .env, and a file without the key is passed over.
  writeFileSync(join(install, '.env.local-auth'), 'FARMSLOT_GATEWAY_TOKEN=gateway-token\n');
  assert.equal(findNodeTokenEnvFile({}, install)?.path, join(install, '.env'));
  writeFileSync(join(install, '.env.local-auth'), 'FARMSLOT_NODE_TOKEN=install-auth-token\n');
  assert.deepEqual(findNodeTokenEnvFile({}, install), {
    path: join(install, '.env.local-auth'),
    token: 'install-auth-token',
  });
  assert.deepEqual(resolveGatewayCredential({ FARMSLOT_NODE_TOKEN: 'service-token' }, install), {
    token: 'install-auth-token',
  });
});

// The node also searches the install root derived from its own source dir: in a
// checkout that is the repo root, whose .env.local-auth may hold a node token.
// A copy of the module laid out as deploy-node installs it keeps that root
// inside the temp dir, as on a deployed node.
const installedNode = (t: TestContext) => {
  // Real path: the node's cwd, and so the file it names, has symlinks resolved.
  const install = join(realpathSync(tempRoot(t, 'farmslot-node-installed-')), 'farmslot-node');
  mkdirSync(join(install, 'src'), { recursive: true });
  mkdirSync(join(install, 'node_modules'));
  const source = dirname(fileURLToPath(import.meta.url));
  for (const name of ['gateway-credential.ts', 'check-node-token.ts'])
    copyFileSync(join(source, name), join(install, 'src', name));
  const tsx = dirname(createRequire(import.meta.url).resolve('tsx/package.json'));
  symlinkSync(tsx, join(install, 'node_modules/tsx'));
  // deploy-node runs the check with the service's node + tsx invocation.
  const check = (deployedToken: string) =>
    spawnSync(
      process.execPath,
      [
        '--require',
        join(install, 'node_modules/tsx/dist/preflight.cjs'),
        '--import',
        pathToFileURL(join(install, 'node_modules/tsx/dist/loader.mjs')).href,
        join(install, 'src/check-node-token.ts'),
      ],
      {
        cwd: install,
        env: { PATH: process.env.PATH },
        input: deployedToken,
        encoding: 'utf8',
        timeout: 10_000,
      },
    );
  return { install, check };
};

test('an installed node with no env file token falls back to its own env', async (t) => {
  const { install } = installedNode(t);
  const installed = (await import(
    pathToFileURL(join(install, 'src/gateway-credential.ts')).href
  )) as typeof import('./gateway-credential.js');
  assert.equal(installed.findNodeTokenEnvFile({}, install), null);
  assert.deepEqual(
    installed.resolveGatewayCredential({ FARMSLOT_NODE_TOKEN: 'service' }, install),
    {
      token: 'service',
    },
  );

  writeFileSync(join(install, '.env'), 'FARMSLOT_GATEWAY_PASSWORD=file-password\n');
  assert.equal(installed.findNodeTokenEnvFile({}, install), null);
  assert.deepEqual(
    installed.resolveGatewayCredential({ FARMSLOT_NODE_TOKEN: 'service' }, install),
    {
      token: 'service',
    },
  );
  assert.deepEqual(installed.resolveGatewayCredential({}, install), { password: 'file-password' });
});

test('the deploy check fails naming the env file whose node token differs, and prints no token', (t) => {
  const { install, check } = installedNode(t);
  const file = join(install, '.env.local-auth');
  writeFileSync(file, 'FARMSLOT_NODE_TOKEN=stale-file-token\n');

  const result = check('deployed-token');

  assert.equal(result.status, 1, result.stderr);
  assert.equal(
    result.stderr,
    `[deploy] ERROR: ${file} sets FARMSLOT_NODE_TOKEN, which the node reads instead of the deployed token\n` +
      '  fix: remove that line (or move the file aside), then redeploy\n',
  );
  assert.equal(result.stdout, '');
});

test('the deploy check passes when the env file holds the deployed token or none', (t) => {
  const { install, check } = installedNode(t);
  const none = check('deployed-token');
  assert.equal(none.status, 0, none.stderr);
  assert.equal(`${none.stdout}${none.stderr}`, '');

  writeFileSync(join(install, '.env.local-auth'), 'FARMSLOT_NODE_TOKEN=deployed-token\n');
  const same = check('deployed-token');
  assert.equal(same.status, 0, same.stderr);
  assert.equal(`${same.stdout}${same.stderr}`, '');
});
