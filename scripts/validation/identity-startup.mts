// Manual startup and browser proof, outside the default suite. Service/node identities only.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GatewayClient } from '../../packages/cli/src/gateway-client.js';
import { testGatewayIdentity, testGatewayProfile } from '../lib/test-gateway-identity-source.mjs';

const source = fileURLToPath(new URL('../../', import.meta.url));
const scratch = await mkdtemp(join(tmpdir(), 'identity-startup-proof-'));
const claims: string[] = [];
let vite: ReturnType<typeof spawn> | undefined;
let transferNode: ReturnType<typeof spawn> | undefined;
let browserRoute: string | undefined;
let env: NodeJS.ProcessEnv | undefined;

async function freePort(): Promise<number> {
  const probe = createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const address = probe.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) => probe.close((e) => (e ? reject(e) : resolve())));
  return address.port;
}

async function waitFor(check: () => Promise<boolean>, description: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, description);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function cli(...args: string[]) {
  return spawnSync(
    process.execPath,
    [join(source, 'packages/cli/bin/farmslot.mjs'), '--json', ...args],
    {
      cwd: source,
      env,
      encoding: 'utf8',
      timeout: 45_000,
    },
  );
}

function cdp(...args: string[]): unknown {
  const result = spawnSync(
    process.execPath,
    [join(source, 'apps/command-center/scripts/cdp.mjs'), ...args],
    {
      // CI passes a checkout-relative TSX config; plain-node tooling must still
      // resolve its profile from an unrelated working directory.
      cwd: scratch,
      env: { ...env, TSX_TSCONFIG_PATH: 'services/gateway/tsconfig.json' },
      encoding: 'utf8',
      timeout: 30_000,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

try {
  for (const marker of ['CLAUDE.md', 'scripts/dev.sh', 'services/gateway/package.json']) {
    const file = join(scratch, marker);
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, marker.endsWith('json') ? '{}' : '');
  }
  for (const dir of ['pool', 'projects', 'bin']) await mkdir(join(scratch, dir));
  await mkdir(join(scratch, 'projects/farmslot-farm'));
  await writeFile(
    join(scratch, 'projects/farmslot-farm/project.json'),
    JSON.stringify({
      name: 'farmslot-farm',
      external: { mock_mode: true },
      task_dir: '.sandbox/farmslot-farm/worker-task',
    }),
  );
  // No runner claim: provide empty read-only enumeration and reject all terminal mutations.
  await writeFile(
    join(scratch, 'bin/tmux'),
    '#!/bin/sh\ncase "$1" in list-sessions|list-panes|list-windows) exit 0;; *) exit 77;; esac\n',
    { mode: 0o700 },
  );
  const port = await freePort();
  const home = join(scratch, 'home');
  const url = `ws://localhost:${port}`;
  env = {
    ...process.env,
    PATH: `${join(scratch, 'bin')}:${process.env.PATH}`,
    FARMSLOT_ROOT: scratch,
    FARMSLOT_HOME: home,
    FARMSLOT_POOL_DIR: join(scratch, 'pool'),
    FARMSLOT_PROJECTS_DIR: join(scratch, 'projects'),
    FARMSLOT_RUNS_DIR: join(scratch, 'runs'),
    FARMSLOT_BACKLOG_FILE: join(scratch, 'backlog.json'),
    FARMSLOT_DISABLE_ORCHESTRATION: '1',
    FARMSLOT_DEMO_POOL: '0',
    FARMSLOT_LOCAL_HEALTH_POLL: '0',
    FARMSLOT_RESOURCE_POLL_ALL: '0',
    FARMSLOT_STARTUP_BRANCH_PREWARM: '0',
    FARMSLOT_ENABLE_TRANSFER_SMOKE: '1',
    SCREEN_CONTROL_SOCKET: join(scratch, 'screen.sock'),
    FARMSLOT_GATEWAY_TOKEN: '',
    FARMSLOT_GATEWAY_PASSWORD: '',
    FARMSLOT_NODE_TOKEN: '',
    FARMSLOT_GATEWAY: url,
    FARMSLOT_GATEWAY_PROFILE: 'local',
  };
  const companionImports = spawnSync(
    process.execPath,
    [
      join(source, 'apps/companion/scripts/agentic/backlog-review-proof.mjs'),
      'identity-import-check',
    ],
    {
      cwd: scratch,
      env: { ...env, TSX_TSCONFIG_PATH: 'services/gateway/tsconfig.json' },
      encoding: 'utf8',
      timeout: 10_000,
    },
  );
  // Reaching the phase guard proves the actual entrypoint loaded. This phase
  // performs no fixture, gateway, simulator or browser action.
  assert.notEqual(companionImports.status, 0);
  assert.match(companionImports.stderr, /Unknown phase identity-import-check/);
  claims.push('plain Node loads the Companion proof entrypoint with inherited TSX config');
  const typedImports = spawnSync(
    process.execPath,
    [
      '--import',
      join(source, 'node_modules/tsx/dist/loader.mjs'),
      '--input-type=module',
      '-e',
      `import { testGatewayIdentity } from ${JSON.stringify(new URL('../lib/test-gateway-identity-source.mjs', import.meta.url).href)};
       if (typeof testGatewayIdentity !== 'function') throw new Error('Missing typed helper');
       const { createWebSocketServer } = await import(${JSON.stringify(new URL('../../services/gateway/src/server.js', import.meta.url).href)});
       if (typeof createWebSocketServer !== 'function') throw new Error('Missing dynamic gateway import');`,
    ],
    {
      cwd: scratch,
      env: { ...env, TSX_TSCONFIG_PATH: join(source, 'services/gateway/tsconfig.json') },
      encoding: 'utf8',
      timeout: 15_000,
    },
  );
  assert.equal(typedImports.status, 0, typedImports.stderr);
  claims.push('typed identity helper preserves subsequent TSX dynamic gateway imports');
  const fresh = cli('up', '--port', String(port), '--no-open', '--no-node');
  assert.notEqual(fresh.status, 0);
  assert.match(fresh.stdout + fresh.stderr, /verified local profile/);
  assert.equal(existsSync(join(home, 'credentials.json')), false);
  claims.push('fresh noninteractive startup refuses without creating a person credential');

  const token = testGatewayIdentity(home);
  testGatewayProfile(home, url, token, 'local');
  const up = cli('up', '--port', String(port), '--no-open');
  if (up.status !== 0) {
    const log = await readFile(join(home, 'gateway.log'), 'utf8');
    throw new Error((up.stderr + up.stdout + log).replaceAll(token, '[test-credential]'));
  }
  const client = new GatewayClient({ url, credential: { token }, timeout: 30_000 });
  await waitFor(async () => {
    const result = await client.call<{ nodes: Array<{ machine: string }> }>('nodes.list', {});
    return result.nodes.some((node) => node.machine === hostname().replace(/\.local$/, ''));
  }, 'local node did not register');
  const listed = await client.call<{
    credentials: Array<{ id: string; principalId: string; revokedAt: string | null }>;
  }>('credential.list', {});
  const principals = await client.call<{
    principals: Array<{ id: string; subject: { type: string } }>;
  }>('principal.list', {});
  const nodeIds = new Set(
    principals.principals.filter((p) => p.subject.type === 'node').map((p) => p.id),
  );
  assert.equal(listed.credentials.filter((c) => nodeIds.has(c.principalId)).length, 1);
  claims.push('credentialed service startup registers one machine-bound node credential');
  const again = cli('up', '--port', String(port), '--no-open');
  assert.equal(again.status, 0, again.stderr + again.stdout);
  const reused = await client.call<{ credentials: unknown[] }>('credential.list', {});
  assert.equal(reused.credentials.length, listed.credentials.length);
  claims.push('repeat startup reuses credentials');

  const originalNode = listed.credentials.find((c) => nodeIds.has(c.principalId))!;
  const originalNodeSecret = (await readFile(join(home, 'node.secret'), 'utf8')).trim();
  const rotatedNode = await client.call<{ secret: string; credential: { id: string } }>(
    'credential.issue',
    { principalId: originalNode.principalId, displayName: 'rotated-startup-proof' },
  );
  const restartNode = async () => {
    const down = cli('down');
    assert.equal(down.status, 0, down.stderr);
    const restarted = cli('up', '--port', String(port), '--no-open');
    assert.equal(restarted.status, 0, restarted.stderr + restarted.stdout);
    await waitFor(async () => {
      const nodes = await client.call<{ nodes: Array<{ machine: string }> }>('nodes.list', {});
      return nodes.nodes.some((node) => node.machine === hostname().replace(/\.local$/, ''));
    }, 'rotated local node did not register');
  };
  env.FARMSLOT_NODE_TOKEN = rotatedNode.secret;
  await restartNode();
  assert.ok(
    (await readFile(join(home, 'node.secret'), 'utf8')).trim() === rotatedNode.secret,
    'startup did not cache the verified replacement node credential',
  );
  await client.call('credential.revoke', { credentialId: originalNode.id });
  env.FARMSLOT_NODE_TOKEN = '';
  await restartNode();
  const rotatedList = await client.call<{
    credentials: Array<{ id: string; principalId: string }>;
  }>('credential.list', {});
  assert.deepEqual(
    rotatedList.credentials.filter((c) => nodeIds.has(c.principalId)).map((c) => c.id),
    [rotatedNode.credential.id],
  );
  claims.push('verified node rotation survives old-credential revocation and restart without env');

  await rm(join(home, 'node.secret'));
  await writeFile(join(scratch, '.env.local-auth'), `FARMSLOT_NODE_TOKEN=${rotatedNode.secret}\n`, {
    mode: 0o600,
  });
  env.FARMSLOT_NODE_TOKEN = originalNodeSecret;
  await restartNode();
  env.FARMSLOT_NODE_TOKEN = '';
  await rm(join(scratch, '.env.local-auth'));
  claims.push('installed node file outranks stale launch env and repairs a missing startup cache');

  // A distinct logical node name forces the real WebSocket/node file path.
  // The co-launched local node above intentionally takes local filesystem paths.
  const transferPrincipal = await client.call<{ principal: { id: string } }>('principal.create', {
    subject: { type: 'node', displayName: 'transfer-proof', machine: 'transfer-proof' },
    roles: [],
  });
  const transferCredential = await client.call<{ secret: string }>('credential.issue', {
    principalId: transferPrincipal.principal.id,
    displayName: 'transfer-proof',
  });
  transferNode = spawn(
    process.execPath,
    ['--import', 'tsx', join(source, 'services/node/src/index.ts')],
    {
      cwd: source,
      env: {
        ...env,
        FARMSLOT_HOME: join(scratch, 'transfer-node-home'),
        FARMSLOT_NODE_TOKEN: transferCredential.secret,
        MACHINE_NAME: 'transfer-proof',
        GATEWAY_URL: url,
        SCREEN_CONTROL_SOCKET: join(scratch, 'transfer-screen.sock'),
        TSX_TSCONFIG_PATH: join(source, 'services/node/tsconfig.json'),
      },
      stdio: 'ignore',
    },
  );
  await waitFor(async () => {
    const result = await client.call<{ nodes: Array<{ machine: string }> }>('nodes.list', {});
    return result.nodes.some((node) => node.machine === 'transfer-proof');
  }, 'transfer node did not register');

  const toolingNodes = cdp('gateway', 'nodes.list') as { nodes: Array<{ machine: string }> };
  assert.ok(toolingNodes.nodes.some((node) => node.machine === 'transfer-proof'));
  claims.push('explicit profile tooling authenticates from scratch cwd with inherited TSX config');

  const transfer = await client.call<{
    ok: boolean;
    httpFileProxy: { status: number; usedChunkedPath: boolean };
  }>('diagnostics.fileTransfer.remoteE2e', { machine: 'transfer-proof', httpCredential: token });
  assert.equal(transfer.httpFileProxy.status, 200);
  assert.equal(transfer.httpFileProxy.usedChunkedPath, true);
  assert.ok(!JSON.stringify(transfer).includes(token));
  claims.push(
    'node transfer and explicit service HTTP self-proxy pass without returning the credential',
  );

  if (process.env.IDENTITY_UI_PROOF === '1') {
    const uiPort = await freePort();
    env.FARMSLOT_UI_URL = `http://127.0.0.1:${uiPort}`;
    vite = spawn(
      process.execPath,
      [
        join(source, 'node_modules/vite/bin/vite.js'),
        '--host',
        '127.0.0.1',
        '--port',
        String(uiPort),
        '--strictPort',
      ],
      {
        cwd: join(source, 'apps/command-center/ui'),
        env: {
          ...env,
          VITE_FARMSLOT_GATEWAY_URL: url,
          VITE_FARMSLOT_GATEWAY_TOKEN: token,
          VITE_FARMSLOT_GATEWAY_PASSWORD: 'obsolete-build-proof',
        },
        stdio: 'ignore',
      },
    );
    await waitFor(async () => {
      try {
        return (await fetch(env!.FARMSLOT_UI_URL!)).ok;
      } catch (error) {
        if (error instanceof TypeError) return false;
        throw error;
      }
    }, 'isolated UI did not start');
    browserRoute = `fleet?identity-proof=${Date.now()}`;
    cdp('goto', `${env.FARMSLOT_UI_URL}/#${browserRoute}`, '--new');
    await waitFor(
      async () =>
        Boolean(cdp('eval', browserRoute, "return !!document.querySelector('.auth-card');")),
      'UI must require login despite obsolete Vite auth values',
    );
    claims.push('browser requires login despite obsolete Vite token/password values');
    assert.equal((cdp('login', browserRoute) as { authenticated: boolean }).authenticated, true);
    claims.push('browser authenticates through the real form using its explicit test profile');
  }
  const logs = await readFile(join(home, 'gateway.log'), 'utf8');
  assert.ok(!logs.includes(token));
  const nodeSecret = (await readFile(join(home, 'node.secret'), 'utf8')).trim();
  assert.ok(!logs.includes(nodeSecret));
  assert.ok(!logs.includes(originalNodeSecret));
  console.log(JSON.stringify({ ok: true, claims }, null, 2));
} finally {
  if (browserRoute) cdp('close', browserRoute);
  if (vite?.pid && vite.exitCode === null && vite.signalCode === null) {
    const exited = once(vite, 'exit');
    vite.kill('SIGTERM');
    await exited;
  }
  if (transferNode?.pid && transferNode.exitCode === null && transferNode.signalCode === null) {
    const exited = once(transferNode, 'exit');
    transferNode.kill('SIGTERM');
    await exited;
  }
  if (env && existsSync(join(env.FARMSLOT_HOME!, 'gateway.pid'))) {
    const down = cli('down');
    assert.equal(down.status, 0, down.stderr);
  }
  await rm(scratch, { recursive: true, force: true });
}
