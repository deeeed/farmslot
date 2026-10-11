import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

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
  const preload = fileURLToPath(
    new URL('../../../../scripts/lib/sandbox-home.cjs', import.meta.url),
  );
  const child = spawnSync(
    process.execPath,
    [
      '--require',
      preload,
      '--import',
      'tsx',
      '--input-type=module',
      '--eval',
      `import {loadGatewayEnvFiles} from ${JSON.stringify(new URL('./gateway-env.ts', import.meta.url).href)};
       import {createGatewayAuthRuntime} from ${JSON.stringify(new URL('../security/auth.ts', import.meta.url).href)};
       loadGatewayEnvFiles(${JSON.stringify(root)});
       delete process.env.FARMSLOT_HOME;
       const runtime=createGatewayAuthRuntime();
       console.log(JSON.stringify({home:process.env.FARMSLOT_HOME,path:runtime.store.path,solo:runtime.resolver.isSoloMode()}));`,
    ],
    {
      encoding: 'utf8',
      timeout: 4900,
      env: {
        ...process.env,
        GATEWAY_HOST: '127.0.0.1',
        FARMSLOT_HOME: sandbox,
        FARMSLOT_SANDBOX_HOME: sandbox,
      },
    },
  );
  assert.equal(child.status, 0, child.stderr);
  const runtime = JSON.parse(child.stdout.trim().split('\n').at(-1)!);
  assert.equal(runtime.home, sandbox);
  assert.equal(runtime.path, path.join(sandbox, 'credentials.json'));
  assert.equal(runtime.solo, true);
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
