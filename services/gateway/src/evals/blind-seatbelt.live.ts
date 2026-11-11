// Manual macOS proof only. Every tmux command selects a private fixture socket.
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { shSingleQuote as q } from '../../../../scripts/lib/shell-quote.mjs';

import { withBlindTrialBoundary } from './blind-git.js';

const python = fileURLToPath(new URL('./blind-git.py', import.meta.url));
const adapter = fileURLToPath(new URL('../../../../packages/adapter-web/', import.meta.url));
const { stopWebDappBrowser } = await import(path.join(adapter, 'src/web-dapp/lib/processes.mjs'));
const syntheticHome = realpathSync(mkdtempSync(path.join('/tmp', 'seatbelt-home-')));
after(() => rmSync(syntheticHome, { recursive: true }));
const env = {
  PATH: process.env.PATH,
  HOME: syntheticHome,
  TMPDIR: os.tmpdir(),
  TMUX_TMPDIR: process.env.TMUX_TMPDIR,
  PYTHONDONTWRITEBYTECODE: '1',
};

function fixture() {
  const root = realpathSync(mkdtempSync(path.join('/tmp', 'blind-seatbelt-live-')));
  mkdirSync(path.join(root, 'boundary'));
  writeFileSync(path.join(root, 'state.json'), '{"originalIsDirectory":true}');
  writeFileSync(
    path.join(root, 'owned-cleanup.mjs'),
    `
export function ownCleanup(parent, stop) {
  let cleanupPromise;
  const cleanup = () => cleanupPromise ??= Promise.resolve().then(async () => {
    clearInterval(watchdog);
    await stop();
  });
  const shutdown = () => { void cleanup().then(() => process.exit(0), error => { console.error(error); process.exit(1); }); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  const watchdog = setInterval(() => {
    try { process.kill(parent, 0); }
    catch (error) { if (error.code !== 'ESRCH') throw error; shutdown(); }
  }, 100);
  return cleanup;
}
`,
  );
  return root;
}
function profile(root: string, launchEnv: NodeJS.ProcessEnv = env) {
  execFileSync(
    'python3',
    [
      '-c',
      `
import pathlib, runpy, sys
blind = runpy.run_path(sys.argv[1], run_name='fixture')
root = pathlib.Path(sys.argv[2])
blind['prepare_boundary']({'repo': str(root), 'siblingRepos': [str(root / 'hidden')]}, root)
`,
      python,
      root,
    ],
    { env: launchEnv, encoding: 'utf8', timeout: 10_000 },
  );
}
function worker(
  root: string,
  command: string,
  launchEnv: NodeJS.ProcessEnv = env,
  timeout = 45_000,
) {
  return spawnSync(
    '/bin/sh',
    [
      '-c',
      withBlindTrialBoundary(command, { capsule: root, baseSha: 'a'.repeat(40) }).replace(
        '/usr/bin/sandbox-exec',
        'exec /usr/bin/sandbox-exec',
      ),
    ],
    {
      env: launchEnv,
      encoding: 'utf8',
      timeout,
    },
  );
}

test(
  'gateway credentials cannot authenticate execution RPCs; task markers remain file-only',
  { skip: process.platform !== 'darwin' },
  async (t) => {
    const root = fixture();
    let stopGateway = async () => {};
    t.after(async () => {
      try {
        await stopGateway();
      } finally {
        rmSync(root, { recursive: true });
      }
    });
    const home = path.join(root, 'home');
    const config = path.join(root, 'boundary/private-config');
    mkdirSync(home);
    mkdirSync(config);
    symlinkSync(config, path.join(home, '.farmslot-automation'));
    const installed = path.join(root, 'external-control/node');
    mkdirSync(installed, { recursive: true });
    symlinkSync(installed, path.join(home, 'farmslot-node-dev'));
    const launchEnv = {
      ...env,
      HOME: home,
      FARMSLOT_HOME: path.join(home, '.farmslot-automation'),
      FARMSLOT_CONFIG_DIR: config,
      FARMSLOT_ROOT: path.join(home, 'farmslot-node'),
    };
    const credentialFiles = [
      ...['.farmslot', '.farmslot-dev/config', '.farmslot-automation'].flatMap((directory) =>
        [
          'gateways.json',
          'credentials.json',
          'provider-accounts.json',
          'active-provider-accounts.json',
          'node.secret',
          'providers.env',
        ].map((name) => path.join(home, directory, name)),
      ),
      path.join(home, '.farmslot-automation/fixture-node-automation.secret'),
      path.join(home, 'Library/LaunchAgents/com.farmslot.node.dev.plist'),
      path.join(home, '.config/systemd/user/farmslot-node-dev.service'),
      path.join(home, 'farmslot-node/.env'),
      path.join(home, 'farmslot-node-dev/.env.ports'),
      path.join(root, 'external-control/.env'),
    ];
    for (const file of credentialFiles) {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, 'synthetic credential only', { mode: 0o600 });
    }
    for (const marker of ['CLAUDE.md', 'scripts/dev.sh', 'services/gateway/package.json']) {
      const file = path.join(launchEnv.FARMSLOT_ROOT, marker);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, marker.endsWith('.json') ? '{}' : 'synthetic root marker');
    }
    // Resolve an individual credential symlink outside the config directory too.
    const target = path.join(root, 'boundary/opaque-credential');
    writeFileSync(target, 'synthetic credential only');
    rmSync(path.join(home, '.farmslot/gateways.json'));
    symlinkSync(target, path.join(home, '.farmslot/gateways.json'));
    credentialFiles.push(...credentialFiles.map((file) => realpathSync(file)), target);
    credentialFiles.push(...credentialFiles.map((file) => file.replace('/private/tmp/', '/tmp/')));
    for (const name of ['gateways.json', 'credentials.json']) rmSync(path.join(config, name));
    const serverScript = path.join(root, 'gateway-fixture.mts');
    writeFileSync(
      serverScript,
      `
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { ownCleanup } from './owned-cleanup.mjs';
import { testGatewayIdentity, testGatewayProfile } from ${JSON.stringify(new URL('../../../../scripts/lib/test-gateway-identity-source.mts', import.meta.url).href)};
import { createGatewayAuthRuntime, initializeGatewayIdentity, authenticateGatewayClient } from ${JSON.stringify(new URL('../security/auth.ts', import.meta.url).href)};
import { createWebSocketServer, disposeServerResourceObservations } from ${JSON.stringify(new URL('../server.ts', import.meta.url).href)};
const home = process.env.FARMSLOT_HOME!;
const token = testGatewayIdentity(home);
const runtime = createGatewayAuthRuntime(process.env);
initializeGatewayIdentity(runtime, { host: '127.0.0.1' });
assert.equal((await authenticateGatewayClient({ runtime, connectParams: { clientKind: 'ui', token }, clientIp: '127.0.0.1' })).ok, true);
const server = createServer();
const wss = createWebSocketServer(server, runtime);
ownCleanup(${process.pid}, async () => {
  for (const client of wss.clients) client.terminate();
  await new Promise<void>((resolve, reject) => wss.close(error => error ? reject(error) : resolve()));
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  disposeServerResourceObservations();
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert.ok(address && typeof address !== 'string');
const url = 'ws://127.0.0.1:' + address.port;
testGatewayProfile(home, url, token);
writeFileSync(${JSON.stringify(path.join(root, 'gateway-ready.json'))}, JSON.stringify({ url }));
`,
    );
    // Importing the production server configures tmux options at module load.
    // Own its socket directory even without the outer test wrapper.
    const gatewayTmux = path.join(root, 'gateway-tmux');
    mkdirSync(gatewayTmux);
    const gateway = spawn(
      process.execPath,
      ['--import', import.meta.resolve('tsx'), serverScript],
      {
        cwd: root,
        env: {
          ...launchEnv,
          TMUX_TMPDIR: gatewayTmux,
          NODE_TEST_CONTEXT: '1',
          TSX_TSCONFIG_PATH: fileURLToPath(new URL('../../tsconfig.json', import.meta.url)),
          FARMSLOT_POOL_DIR: path.join(root, 'pool'),
          FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
          FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const exited = once(gateway, 'exit');
    let stderr = '';
    gateway.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    gateway.stdout.resume();
    stopGateway = async () => {
      if (gateway.exitCode === null && gateway.signalCode === null) {
        gateway.kill('SIGTERM');
        const deadline = Date.now() + 3000;
        while (gateway.exitCode === null && gateway.signalCode === null && Date.now() < deadline)
          await delay(25);
        if (gateway.exitCode === null && gateway.signalCode === null) gateway.kill('SIGKILL');
      }
      await exited;
    };
    const ready = path.join(root, 'gateway-ready.json');
    const deadline = Date.now() + 20_000;
    while (!existsSync(ready) && gateway.exitCode === null && Date.now() < deadline)
      await delay(25);
    assert.ok(existsSync(ready), stderr);
    const { url } = JSON.parse(readFileSync(ready, 'utf8'));
    const token = JSON.parse(readFileSync(path.join(config, 'gateways.json'), 'utf8')).gateways
      .proof.secret;
    profile(root, launchEnv);
    // A profile materialized after boundary generation still carries no authority.
    const late = path.join(root, 'late-config');
    mkdirSync(late);
    const lateProfile = path.join(late, 'gateways.json');
    writeFileSync(lateProfile, JSON.stringify({ gateways: { proof: { url, secret: token } } }));
    credentialFiles.push(lateProfile);
    const alias = path.join(root, 'worker-profile-alias');
    symlinkSync(path.join(config, 'gateways.json'), alias);
    const task = path.join(root, 'task');
    mkdirSync(task);
    writeFileSync(path.join(task, 'CHECKLIST.md'), '# Synthetic task\n- [ ] Prove local marking\n');
    const probe = path.join(root, 'gateway-probe.mjs');
    writeFileSync(
      probe,
      `
import assert from 'node:assert/strict';
import { readFileSync, renameSync, linkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import WebSocket from ${JSON.stringify(import.meta.resolve('ws'))};
for (const name of ['FARMSLOT_NODE_TOKEN', 'FARMSLOT_GATEWAY_TOKEN', 'FARMSLOT_GATEWAY_PASSWORD', 'GW_URL', 'GATEWAY_URL', 'FARMSLOT_GATEWAY', 'FARMSLOT_GATEWAY_PROFILE']) assert.equal(process.env[name], undefined, name);
for (const file of ${JSON.stringify([...new Set([...credentialFiles, alias])])}) {
  assert.throws(() => readFileSync(file), { code: 'EPERM' });
  if (file !== ${JSON.stringify(alias)}) assert.throws(() => renameSync(file, file + '-moved'), { code: 'EPERM' });
  assert.throws(() => linkSync(file, file + '-linked'), { code: 'EPERM' });
}
for (const directory of ${JSON.stringify([home, config, path.dirname(config), path.join(home, '.farmslot'), path.join(home, '.farmslot-dev'), path.join(home, '.farmslot-automation')])}) assert.throws(() => renameSync(directory, directory + '-moved'), { code: 'EPERM' });
renameSync(${JSON.stringify(late)}, ${JSON.stringify(late + '-moved')});
assert.throws(() => readFileSync(${JSON.stringify(late + '-moved/gateways.json')}), { code: 'EPERM' });
const marked = spawnSync(process.execPath, [${JSON.stringify(fileURLToPath(new URL('../../../../packages/agent-runtime/scripts/mark-checklist-step.cjs', import.meta.url)))}, ${JSON.stringify(task)}, '1'], { encoding: 'utf8' });
assert.equal(marked.status, 0, marked.stderr);
assert.ok(readFileSync(${JSON.stringify(path.join(task, 'CHECKLIST.md'))}, 'utf8').includes('- [x] Prove local marking'));
assert.ok(JSON.parse(readFileSync(${JSON.stringify(path.join(task, 'SIGNAL.json'))}, 'utf8')));
// The endpoint is deliberately known. Reachability must not grant execution authority.
const socket = new WebSocket(${JSON.stringify(url)});
const timeout = setTimeout(() => { socket.terminate(); throw new Error('synthetic gateway RPC timed out'); }, 2500);
try {
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  const rpc = (id, method, params) => new Promise((resolve, reject) => {
    const receive = raw => { const frame = JSON.parse(raw); if (frame.type === 'res' && frame.id === id) { socket.off('message', receive); resolve(frame); } };
    socket.on('message', receive);
    socket.send(JSON.stringify({ type: 'req', id, method, params }));
  });
  const auth = await rpc('auth', 'auth.connect', { clientKind: 'ui', token: process.env.FARMSLOT_GATEWAY_TOKEN });
  assert.equal(auth.ok, false);
  const execution = await rpc('execution', 'tmux.pasteText', { session: 'synthetic', text: 'synthetic no-op', submit: true });
  assert.equal(execution.ok, false);
  assert.equal(execution.error.code, 'AUTH_REQUIRED');
  console.log('synthetic gateway reachable; authentication and tmux.pasteText refused; local marker updated CHECKLIST/SIGNAL');
} finally { clearTimeout(timeout); socket.terminate(); }
`,
    );
    const result = worker(root, `exec ${q(process.execPath)} ${q(probe)}`, {
      ...launchEnv,
      FARMSLOT_NODE_TOKEN: 'synthetic-node',
      FARMSLOT_GATEWAY_TOKEN: token,
      FARMSLOT_GATEWAY_PASSWORD: 'synthetic-password',
      GW_URL: url,
      GATEWAY_URL: url,
      FARMSLOT_GATEWAY: url,
      FARMSLOT_GATEWAY_PROFILE: 'proof',
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    t.diagnostic(result.stdout.trim());
  },
);

test(
  'SSH execution, loopback remote shells, credentials and a known agent socket are denied',
  { skip: process.platform !== 'darwin' },
  async (t) => {
    const root = fixture();
    const agent = net.createServer((socket) => socket.destroy());
    t.after(async () => {
      try {
        if (agent.listening)
          await new Promise<void>((resolve, reject) =>
            agent.close((error) => (error ? reject(error) : resolve())),
          );
      } finally {
        rmSync(root, { recursive: true });
      }
    });
    const home = path.join(root, 'home');
    const credentials = path.join(root, 'credentials');
    mkdirSync(home);
    mkdirSync(credentials);
    symlinkSync(credentials, path.join(home, '.ssh'));
    for (const name of ['id_ed25519', 'config', 'known_hosts'])
      writeFileSync(path.join(credentials, name), 'synthetic SSH fixture only', { mode: 0o600 });
    const socket = path.join(root, 'agent.sock');
    agent.listen(socket);
    await once(agent, 'listening');
    const launchEnv = { ...env, HOME: home, SSH_AUTH_SOCK: socket, SSH_AGENT_PID: '123' };
    profile(root, launchEnv);
    const probe = path.join(root, 'ssh-probe.mjs');
    writeFileSync(
      probe,
      `
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, renameSync, linkSync } from 'node:fs';
import net from 'node:net';
assert.equal(process.env.SSH_AUTH_SOCK, undefined);
assert.equal(process.env.SSH_AGENT_PID, undefined);
const home = ${JSON.stringify(home)};
const credentials = ${JSON.stringify(credentials)};
for (const directory of [home + '/.ssh', credentials]) {
  for (const name of ['id_ed25519', 'config', 'known_hosts'])
    assert.throws(() => readFileSync(directory + '/' + name), { code: 'EPERM' });
  assert.throws(() => renameSync(directory, directory + '-moved'), { code: 'EPERM' });
  assert.throws(() => linkSync(directory + '/id_ed25519', home + '/linked-key'), { code: 'EPERM' });
}
assert.throws(() => renameSync(home, home + '-moved'), { code: 'EPERM' });
const deniedConnection = options => new Promise((resolve, reject) => {
  const client = net.connect(options);
  const timer = setTimeout(() => { client.destroy(); reject(new Error('connection did not fail promptly')); }, 1500);
  client.once('connect', () => { clearTimeout(timer); client.destroy(); reject(new Error('sandbox allowed connection')); });
  client.once('error', error => {
    clearTimeout(timer);
    client.destroy();
    try { assert.equal(error.code, 'EPERM'); resolve(); }
    catch (failure) { reject(failure); }
  });
});
// Raw TCP proves the network rule even if a worker copies an SSH client.
for (const host of ['localhost', '127.0.0.1', '::1', '127.0.0.2', '::ffff:127.0.0.1'])
  for (const port of [22, 512, 513, 514]) await deniedConnection({ host, port });
// Knowing or re-exporting the agent path must not restore access.
process.env.SSH_AUTH_SOCK = ${JSON.stringify(socket)};
await deniedConnection({ path: process.env.SSH_AUTH_SOCK });
for (const host of ['localhost', '127.0.0.1', '::1']) {
  const result = spawnSync('/usr/bin/ssh', ['-F', '/dev/null', '-o', 'BatchMode=yes', '-o', 'IdentityAgent=none', '-o', 'IdentitiesOnly=yes', '-o', 'PreferredAuthentications=none', '-o', 'ConnectTimeout=1', host, 'true']);
  assert.ok(['EPERM', 'EACCES'].includes(result.error?.code), 'SSH execution must be denied');
}
for (const executable of ['/usr/bin/scp', '/usr/bin/sftp']) {
  const result = spawnSync(executable, ['-h']);
  assert.ok(['EPERM', 'EACCES'].includes(result.error?.code), executable + ' execution must be denied');
}
console.log('SSH/scp/sftp execution denied; loopback TCP 22/512/513/514 denied across IPv4/IPv6; synthetic SSH files unreadable; agent env stripped and known socket unusable');
`,
    );
    const result = worker(root, `exec ${q(process.execPath)} ${q(probe)}`, launchEnv);
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    t.diagnostic(result.stdout.trim());
  },
);

test(
  'reconnaissance reads and alternate process launch paths stay blocked',
  { skip: process.platform !== 'darwin' },
  (t) => {
    const root = fixture();
    t.after(() => rmSync(root, { recursive: true }));
    const home = path.join(root, 'home');
    const blocked = ['.pi/agent/settings.json'];
    const allowed: string[] = [];
    for (const installation of ['farmslot-node', 'farmslot-node-dev']) {
      blocked.push(
        ...[
          'src/index.ts',
          'scripts/dev-stack/start.sh',
          'pool/fixture.json',
          'projects/fixture/private.txt',
        ].map((file) => `${installation}/${file}`),
      );
      allowed.push(
        ...[
          'support/fixture/scripts/proof.mjs',
          'node_modules/fixture/index.js',
          'packages/agent-runtime/scripts/proof.cjs',
        ].map((file) => `${installation}/${file}`),
      );
      // A runtime exception must never reopen installed wrapper source reads.
      blocked.push(`${installation}/node_modules/@farmslot/gateway/src/evals/blind-git.py`);
    }
    blocked.push('outside/services/gateway/src/evals/blind-git.ts');
    for (const file of [...blocked, ...allowed]) {
      mkdirSync(path.dirname(path.join(home, file)), { recursive: true });
      writeFileSync(path.join(home, file), "console.log('synthetic helper executed');");
    }
    const launchEnv = { ...env, HOME: home };
    profile(root, launchEnv);
    const denied = [
      ...blocked.map((file) => path.join(home, file)),
      path.join(root, 'boundary/sandbox.sb'),
    ];
    // Exercise a worker-created alias as well as the resolved profile path.
    const profileAlias = path.join(root, 'profile-alias');
    symlinkSync(path.join(root, 'boundary/sandbox.sb'), profileAlias);
    denied.push(profileAlias);
    const copiedPs = path.join(root, 'copied-ps');
    copyFileSync('/bin/ps', copiedPs);
    const label = `seatbelt-fixture-${process.pid}-${path.basename(root)}`;
    t.after(() => {
      const removed = spawnSync('/bin/launchctl', ['remove', label], {
        env,
        encoding: 'utf8',
        timeout: 2000,
      });
      assert.ifError(removed.error);
      assert.ok([0, 3, 113].includes(removed.status!), removed.stderr);
    });
    const probe = path.join(root, 'recon-probe.mjs');
    writeFileSync(
      probe,
      `
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, renameSync, linkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
for (const file of ${JSON.stringify(denied)}) assert.throws(() => readFileSync(file), { code: 'EPERM' });
for (const file of ${JSON.stringify(denied.filter((file) => file !== profileAlias))}) {
  assert.throws(() => renameSync(file, file + '-moved'), { code: 'EPERM' });
  assert.throws(() => linkSync(file, file + '-linked'), { code: 'EPERM' });
}
for (const directory of ${JSON.stringify(['.pi', '.pi/agent', 'farmslot-node', 'farmslot-node-dev'].map((file) => path.join(home, file)).concat([path.join(root, 'boundary')]))}) assert.throws(() => renameSync(directory, directory + '-moved'), { code: 'EPERM' });
for (const installation of ['farmslot-node', 'farmslot-node-dev']) assert.throws(() => readdirSync(${JSON.stringify(home)} + '/' + installation), { code: 'EPERM' });
for (const file of ${JSON.stringify(allowed.map((file) => path.join(home, file)))}) {
  assert.equal(readFileSync(file, 'utf8'), "console.log('synthetic helper executed');");
  const helper = spawnSync(process.execPath, [file]);
  assert.equal(helper.status, 0, helper.stderr.toString());
  assert.equal(helper.stdout.toString().trim(), 'synthetic helper executed');
}
const launch = spawnSync('/bin/launchctl', ['submit', '-l', ${JSON.stringify(label)}, '--', '/bin/ps', '-p', '1'], { timeout: 2000 });
assert.notEqual(launch.status, 0, 'launchctl submit must fail');
const copied = spawnSync(${JSON.stringify(copiedPs)}, ['-p', '1'], { timeout: 2000 });
assert.notEqual(copied.status, 0, 'copied ps must remain non-functional');
console.log('synthetic settings/profile/wrapper/node reads denied; support/dependencies/helpers executed; launchctl submit and copied ps non-functional');
`,
    );
    const result = worker(root, `exec ${q(process.execPath)} ${q(probe)}`, launchEnv);
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    t.diagnostic(result.stdout.trim());
  },
);

test(
  'private tmux servers refuse worker control; gateway-side control and pane identity survive',
  { skip: process.platform !== 'darwin' },
  (t) => {
    const root = fixture();
    const socketDir = path.join(root, `tmux-${process.getuid!()}`);
    mkdirSync(socketDir, { mode: 0o700 });
    const sockets = [path.join(socketDir, 'default'), path.join(root, 'custom.sock')];
    const tmux = (socket: string, ...args: string[]) =>
      execFileSync('tmux', ['-f', '/dev/null', '-S', socket, ...args], {
        env,
        encoding: 'utf8',
        timeout: 3000,
      });
    const started: string[] = [];
    // spawnSync returns each failure so one missing server cannot skip the next.
    const stopServers = () =>
      started.map((socket) =>
        spawnSync('tmux', ['-S', socket, 'kill-server'], {
          env,
          encoding: 'utf8',
          timeout: 3000,
        }),
      );
    t.after(() => {
      try {
        const results = stopServers();
        for (const result of results) {
          assert.ifError(result.error);
          // The regression below deliberately stops the first server early.
          if (result.status !== 0)
            assert.match(result.stderr, /No such file or directory|no server running/u);
        }
      } finally {
        rmSync(root, { recursive: true });
      }
    });
    for (const socket of sockets) {
      tmux(socket, 'new-session', '-d', '-s', 'fixture', '/bin/cat');
      started.push(socket);
    }
    const pane = tmux(sockets[0], 'display-message', '-p', '-t', 'fixture', '#{pane_id}').trim();
    const launchEnv = { ...env, TMUX_TMPDIR: root, TMUX_PANE: pane };
    // custom.sock is learned from lsof, not inherited TMUX or a default directory.
    profile(root, launchEnv);
    const sandbox = readFileSync(path.join(root, 'boundary/sandbox.sb'), 'utf8');
    assert.ok(sandbox.includes(`(literal "${sockets[1]}")`), sandbox);
    // These servers did not exist when lsof and profile generation ran.
    const lateRoot = path.join(root, 'late');
    mkdirSync(lateRoot);
    const lateDirectory = path.join(lateRoot, `tmux-${process.getuid!()}`);
    mkdirSync(lateDirectory, { mode: 0o700 });
    const lateSockets = [path.join(lateDirectory, 'default'), path.join(lateRoot, 'explicit.sock')];
    execFileSync('tmux', ['-f', '/dev/null', 'new-session', '-d', '-s', 'fixture', '/bin/cat'], {
      env: { ...env, TMUX_TMPDIR: lateRoot },
      encoding: 'utf8',
      timeout: 3000,
    });
    started.push(lateSockets[0]);
    tmux(lateSockets[1], 'new-session', '-d', '-s', 'fixture', '/bin/cat');
    started.push(lateSockets[1]);
    const alias = path.join(root, 'alias.sock');
    symlinkSync(sockets[1], alias);
    const hardAlias = path.join(root, 'hard.sock');
    linkSync(sockets[1], hardAlias);
    const marker = path.join(root, 'escaped');
    for (const prefix of [
      `TMUX_TMPDIR=${q(root)} tmux`,
      `TMUX_TMPDIR=${q(lateRoot)} tmux`,
      ...[
        ...lateSockets,
        ...sockets,
        ...sockets.map((s) => s.replace('/private/tmp/', '/tmp/')),
        alias,
        hardAlias,
      ].map((s) => `tmux -S ${q(s)}`),
    ]) {
      for (const action of [
        `new-session -d -s escape ${q(`touch ${q(marker)}`)}`,
        `run-shell -t fixture ${q(`touch ${q(marker)}`)}`,
        `send-keys -t fixture injected Enter`,
      ]) {
        const result = worker(root, `${prefix} ${action}`, launchEnv);
        assert.ifError(result.error);
        assert.notEqual(result.status, 0, `${prefix} ${action}`);
        assert.match(result.stderr, /Operation not permitted|Permission denied/u);
      }
    }
    const identity = worker(
      root,
      `test -z "\${TMUX-}\${TMUX_TMPDIR-}" && test "$TMUX_PANE" = ${q(pane)}`,
      launchEnv,
    );
    assert.equal(identity.status, 0, identity.stderr);
    assert.equal(existsSync(marker), false);
    assert.doesNotMatch(tmux(sockets[0], 'capture-pane', '-p', '-t', 'fixture'), /injected/u);
    // The trusted caller outside the sandbox still controls its own private pane.
    tmux(sockets[0], 'send-keys', '-t', 'fixture', 'observable', 'Enter');
    assert.match(tmux(sockets[0], 'capture-pane', '-p', '-t', 'fixture'), /observable/u);
    for (const socket of lateSockets)
      assert.doesNotMatch(tmux(socket, 'capture-pane', '-p', '-t', 'fixture'), /injected/u);
    // Prove teardown still reaches the second server when the first is gone.
    tmux(sockets[0], 'kill-server');
    const cleanup = stopServers();
    assert.notEqual(cleanup[0].status, 0);
    assert.equal(cleanup[1].status, 0, cleanup[1].stderr);

    t.diagnostic(
      'new-session/run-shell/send-keys denied for existing and post-profile private servers; trusted control passed; cleanup attempted every server',
    );
  },
);

test(
  'same-UID ownership and headless Chrome CDP work under the retained outer seatbelt',
  { skip: process.platform !== 'darwin' },
  async (t) => {
    const root = fixture();
    t.after(async () => {
      try {
        await stopWebDappBrowser(root, {
          runtimeDir: path.join(root, 'temp/recipe/runtime/terminal'),
        });
      } finally {
        rmSync(root, { recursive: true });
      }
    });
    profile(root);
    const probe = path.join(root, 'probe.mjs');
    const hidden = path.join(root, 'hidden');
    mkdirSync(hidden);
    writeFileSync(path.join(hidden, 'hidden'), 'synthetic hidden input');
    writeFileSync(
      path.join(root, 'base-policy.mjs'),
      readFileSync(path.join(adapter, 'test/fixtures/web-dapp-policy.mjs'), 'utf8'),
    );
    writeFileSync(
      path.join(root, 'policy.mjs'),
      `import { policy as base } from './base-policy.mjs';
export const policy = { ...base, module: import.meta.filename, venueHosts: () => ({ blocked: ['mainnet.example.invalid'], served: [], servedCheck: 'not-applicable' }) };`,
    );
    // Public development mnemonic, synthetic account only.
    writeFileSync(
      path.join(root, 'wallet.json'),
      JSON.stringify({
        password: 'fixture-only',
        accounts: [
          {
            name: 'dev1',
            type: 'mnemonic',
            value: 'test test test test test test test test test test test junk',
          },
        ],
      }),
      { mode: 0o600 },
    );
    writeFileSync(
      probe,
      `
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { ownCleanup } from './owned-cleanup.mjs';
import { launchWebDappBrowser } from ${JSON.stringify(path.join(adapter, 'src/web-dapp/launch.mjs'))};
import { processInfo } from ${JSON.stringify(path.join(adapter, 'src/web-dapp/lib/process-info.mjs'))};
import { ownsProcess, stopWebDappBrowser } from ${JSON.stringify(path.join(adapter, 'src/web-dapp/lib/processes.mjs'))};
const root = ${JSON.stringify(root)};
process.env.RECIPE_WEB_DAPP_POLICY = root + '/policy.mjs';
process.env.RECIPE_WALLET_FIXTURE = root + '/wallet.json';
if (${JSON.stringify(process.env.SEATBELT_TEST_CHROME ?? '')}) process.env.TERMINAL_CHROME_BIN = ${JSON.stringify(process.env.SEATBELT_TEST_CHROME ?? '')};
assert.notEqual(spawnSync('/bin/ps', ['-p', String(process.pid)]).status, 0);
assert.throws(() => readFileSync(root + '/hidden/hidden'), { code: 'EPERM' });
const app = http.createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><title>Seatbelt fixture</title><p>Synthetic app</p>'); });
const portProbe = net.createServer();
const runtime = root + '/temp/recipe/runtime/terminal';
const stop = () => stopWebDappBrowser(root, { runtimeDir: runtime });
const mode = process.argv[2] ?? 'normal';
const parent = Number(process.argv[3] ?? ${process.pid});
let launching;
const close = server => new Promise((resolve, reject) => {
  if (!server.listening) return resolve();
  server.close(error => error ? reject(error) : resolve());
  server.closeAllConnections?.();
});
const cleanup = ownCleanup(parent, async () => {
  try { await launching; }
  finally {
    try { await stop(); }
    finally { await Promise.all([close(app), close(portProbe)]); }
  }
});
try {
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  portProbe.listen(0, '127.0.0.1');
  await once(portProbe, 'listening');
  const cdpPort = portProbe.address().port;
  await close(portProbe);
  const args = { target: root, 'cdp-port': cdpPort, 'app-port': app.address().port, signer: 'injected', account: 'dev1', headless: true, 'fresh-profile': true };
  launching = launchWebDappBrowser(args, process.env, { timeouts: { browserStartMs: 10000, hostReadyMs: 15000 } });
  const state = await launching;
  assert.equal(state.browser.launchMethod, 'spawn');
  assert.equal(state.browser.outerSeatbelt, true);
  const version = await fetch('http://127.0.0.1:' + cdpPort + '/json/version').then(r => r.json());
  assert.ok(version.webSocketDebuggerUrl);
  assert.equal(ownsProcess('browser', state.browserPid, runtime), true);
  assert.equal(ownsProcess('browser', state.browserPid, runtime + '-foreign'), false);
  const info = processInfo(state.browserPid);
  assert.ok(info.state);
  assert.ok(info.startedAt);
  assert.equal(info.pgid, state.browserPid);
  assert.equal(info.startedAt, processInfo(state.browserPid).startedAt);
  assert.ok(info.argv.includes('--no-sandbox'));
  if (mode !== 'normal') {
    writeFileSync(root + '/ready-' + mode + '.json', JSON.stringify({ probePid: process.pid, browserPid: state.browserPid, hostPid: state.hostPid, appPort: app.address().port, cdpPort }));
    await new Promise(() => {});
  }
  const reused = await launchWebDappBrowser({ ...args, 'fresh-profile': false });
  assert.equal(reused.reused, true);
  assert.equal(reused.browserPid, state.browserPid);
  const stopped = await stop();
  assert.equal(stopped.stopped.length, 2);
  console.log('ps denied; ownership/group/state/start identity passed; harness launched and reused Chrome; Chrome CDP served; outer read denial retained');
} finally {
  await cleanup();
}
`,
    );
    const result = worker(root, `exec ${q(process.execPath)} ${q(probe)}`);
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Chrome CDP served; outer read denial retained/u);
    t.diagnostic(result.stdout.trim());
    for (const mode of ['SIGTERM', 'SIGINT', 'parent-death'] as const) {
      await t.test(`full cleanup on ${mode}`, async (childTest) => {
        const parent = spawn(process.execPath, ['-e', 'setInterval(() => {}, 100)'], {
          env,
          stdio: 'ignore',
        });
        childTest.after(async () => {
          if (parent.exitCode === null && parent.signalCode === null) {
            const exited = once(parent, 'exit');
            parent.kill();
            await exited;
          }
        });
        await once(parent, 'spawn');
        const child = spawn(
          '/bin/sh',
          [
            '-c',
            withBlindTrialBoundary(
              `exec ${q(process.execPath)} ${q(probe)} ${q(mode)} ${parent.pid}`,
              { capsule: root, baseSha: 'a'.repeat(40) },
            ).replace('/usr/bin/sandbox-exec', 'exec /usr/bin/sandbox-exec'),
          ],
          { env, stdio: ['ignore', 'pipe', 'pipe'] },
        );
        const exited = once(child, 'exit');
        let stderr = '';
        child.stderr.on('data', (chunk) => {
          stderr += chunk;
        });
        // SIGTERM invokes the same complete cleanup if an assertion fails.
        childTest.after(async () => {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGTERM');
            const deadline = Date.now() + 3000;
            while (child.exitCode === null && child.signalCode === null && Date.now() < deadline)
              await delay(25);
            if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
            await exited;
          }
          await stopWebDappBrowser(root, {
            runtimeDir: path.join(root, 'temp/recipe/runtime/terminal'),
          });
        });
        const ready = path.join(root, `ready-${mode}.json`);
        const deadline = Date.now() + 20000;
        while (!existsSync(ready) && child.exitCode === null && Date.now() < deadline)
          await delay(25);
        assert.ok(existsSync(ready), stderr);
        const state = JSON.parse(readFileSync(ready, 'utf8'));
        if (mode === 'parent-death') {
          const parentExited = once(parent, 'exit');
          parent.kill();
          await parentExited;
        } else process.kill(state.probePid, mode);
        const exitDeadline = Date.now() + 3000;
        while (child.exitCode === null && child.signalCode === null && Date.now() < exitDeadline)
          await delay(25);
        assert.ok(
          child.exitCode !== null || child.signalCode !== null,
          `${mode} did not exit after cleanup`,
        );
        const [code, signal] = await exited;
        assert.equal(code, 0, stderr);
        assert.equal(signal, null);
        for (const pid of [state.browserPid, state.hostPid])
          assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
        for (const port of [state.appPort, state.cdpPort]) {
          await assert.rejects(
            fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(500) }),
          );
        }
      });
    }
  },
);

test(
  'worker tools and DNS work with only the system resolver Unix socket allowed',
  { skip: process.platform !== 'darwin' },
  async (t) => {
    const root = fixture();
    t.after(() => rmSync(root, { recursive: true }));
    profile(root);
    const pi = execFileSync('/usr/bin/which', ['pi'], { env, encoding: 'utf8' }).trim();
    const piProbe = path.join(root, 'pi-probe.mjs');
    writeFileSync(
      piProbe,
      String.raw`
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { ownCleanup } from './owned-cleanup.mjs';
const root = ${JSON.stringify(root)};
const mode = process.argv[2] ?? 'normal';
const server = http.createServer((req, res) => {
  req.resume();
  if (mode !== 'normal') {
    if (mode !== 'readiness-timeout') writeFileSync(root + '/pi-ready-' + mode + '.json', JSON.stringify({ probePid: process.pid, piPid: child.pid }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const chunk = { id: 'fixture', object: 'chat.completion.chunk', created: 0, model: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', content: 'seatbelt-fixture-ok' }, finish_reason: null }] };
  res.write('data: ' + JSON.stringify(chunk) + '\n\n');
  res.write('data: ' + JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n');
  res.end('data: [DONE]\n\n');
});
let child;
const cleanup = ownCleanup(Number(process.argv[3] ?? ${process.pid}), async () => {
  try {
    if (child && child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close');
      child.kill();
      const escalation = setTimeout(() => child.kill('SIGKILL'), 500);
      try { await closed; }
      finally { clearTimeout(escalation); }
    }
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve()));
  }
});
try {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const agent = root + '/pi-agent-' + mode;
  mkdirSync(agent);
  const extension = agent + '/fixture-extension.mjs';
  writeFileSync(extension, "import { writeFileSync } from 'node:fs'; export default function(pi) { pi.on('session_start', () => writeFileSync(" + JSON.stringify(agent + '/extension-loaded') + ", 'synthetic extension loaded')); }");
  writeFileSync(agent + '/models.json', JSON.stringify({ providers: { 'seatbelt-fixture': {
    baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1', api: 'openai-completions', apiKey: 'fixture-only',
    models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 128 }],
  } } }));
  child = spawn(${JSON.stringify(pi)}, ['--offline', '--print', '--no-session', '--no-tools', '--no-extensions', '--extension', extension, '--no-mcp', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-themes', '--provider', 'seatbelt-fixture', '--model', 'fixture', '--system-prompt', 'Synthetic fixture only.', 'Reply with seatbelt-fixture-ok'], { cwd: root, env: { ...process.env, PI_CODING_AGENT_DIR: agent }, stdio: ['ignore', 'pipe', 'pipe'] });
  writeFileSync(root + '/pi-spawned-' + mode + '.json', JSON.stringify({ piPid: child.pid }));
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const [code, signal] = await once(child, 'close');
  if (mode !== 'normal') {
    assert.ok(signal, 'interrupted Pi should be terminated');
  } else {
    assert.equal(code, 0, stderr);
    assert.match(stdout, /seatbelt-fixture-ok/u);
    assert.equal((await import('node:fs')).readFileSync(agent + '/extension-loaded', 'utf8'), 'synthetic extension loaded');
    console.log('pi loaded its synthetic extension and completed a turn through a local synthetic provider');
  }
} finally {
  await cleanup();
}
`,
    );
    for (const command of [
      `${q(pi)} --version`,
      `${q(pi)} --help`,
      `exec ${q(process.execPath)} ${q(piProbe)}`,
      `git init -q ${q(path.join(root, 'tools'))} && git -C ${q(path.join(root, 'tools'))} status --porcelain && printf fixture | git hash-object --stdin`,
      `${q(process.execPath)} --input-type=module -e ${q("import dns from 'node:dns/promises'; import { spawnSync } from 'node:child_process'; import assert from 'node:assert/strict'; assert.ok((await dns.lookup('example.com')).address); assert.equal(spawnSync('/usr/bin/true').status, 0); console.log('Node DNS and child spawning passed');")}`,
    ]) {
      const result = worker(root, command);
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
    }
    for (const mode of [
      'timeout',
      'SIGTERM',
      'SIGINT',
      'parent-death',
      'readiness-timeout',
    ] as const) {
      await t.test(`interrupted pi fixture cleans up on ${mode}`, async (childTest) => {
        const ready = path.join(root, `pi-ready-${mode}.json`);
        const spawned = path.join(root, `pi-spawned-${mode}.json`);
        let cleanupProbe: (() => Promise<void>) | undefined;
        // A failed regression must still reap the owned fixture child.
        childTest.after(async () => {
          await (cleanupProbe?.() ?? Promise.resolve()).finally(() => {
            if (existsSync(spawned)) {
              const { piPid } = JSON.parse(readFileSync(spawned, 'utf8'));
              try {
                process.kill(piPid, 'SIGKILL');
              } catch (error) {
                if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH'))
                  throw error;
              }
            }
          });
        });
        if (mode === 'timeout') {
          const result = worker(
            root,
            `exec ${q(process.execPath)} ${q(piProbe)} timeout`,
            env,
            3000,
          );
          assert.ok(result.error && 'code' in result.error);
          assert.equal(result.error.code, 'ETIMEDOUT');
        } else {
          const parent = spawn(process.execPath, ['-e', 'setInterval(() => {}, 100)'], {
            env,
            stdio: 'ignore',
          });
          const parentExited = once(parent, 'exit');
          childTest.after(async () => {
            parent.kill();
            await parentExited;
          });
          await once(parent, 'spawn');
          const child = spawn(
            '/bin/sh',
            [
              '-c',
              withBlindTrialBoundary(
                `exec ${q(process.execPath)} ${q(piProbe)} ${q(mode)} ${parent.pid}`,
                { capsule: root, baseSha: 'a'.repeat(40) },
              ).replace('/usr/bin/sandbox-exec', 'exec /usr/bin/sandbox-exec'),
            ],
            { env, stdio: ['ignore', 'pipe', 'pipe'] },
          );
          const exited = once(child, 'exit');
          let stderr = '';
          child.stderr.on('data', (chunk) => {
            stderr += chunk;
          });
          cleanupProbe = async () => {
            if (child.exitCode === null && child.signalCode === null) {
              child.kill('SIGTERM');
              const deadline = Date.now() + 3000;
              while (child.exitCode === null && child.signalCode === null && Date.now() < deadline)
                await delay(25);
              if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
            }
            await exited;
          };
          if (mode === 'readiness-timeout') {
            const spawnDeadline = Date.now() + 10000;
            while (!existsSync(spawned) && child.exitCode === null && Date.now() < spawnDeadline)
              await delay(25);
            assert.ok(existsSync(spawned), stderr);
            const { piPid } = JSON.parse(readFileSync(spawned, 'utf8'));
            process.kill(piPid, 0);
          }
          const deadline = Date.now() + (mode === 'readiness-timeout' ? 100 : 10000);
          while (
            !existsSync(ready) &&
            child.exitCode === null &&
            child.signalCode === null &&
            Date.now() < deadline
          )
            await delay(25);
          if (mode !== 'readiness-timeout') assert.ok(existsSync(ready), stderr);
          if (mode === 'readiness-timeout') {
            assert.equal(existsSync(ready), false, 'Pi readiness must time out');
            await cleanupProbe();
            const { piPid } = JSON.parse(readFileSync(spawned, 'utf8'));
            // Assert before the fallback hook can hide an orphaned Pi.
            assert.throws(() => process.kill(piPid, 0), { code: 'ESRCH' });
          } else if (mode === 'parent-death') {
            parent.kill();
            await parentExited;
          } else child.kill(mode);
          const exitDeadline = Date.now() + 3000;
          while (child.exitCode === null && child.signalCode === null && Date.now() < exitDeadline)
            await delay(25);
          assert.ok(
            child.exitCode !== null || child.signalCode !== null,
            `${mode} did not exit after cleanup`,
          );
          const [code, signal] = await exited;
          assert.equal(code, 0, stderr);
          assert.equal(signal, null);
        }
        if (mode !== 'readiness-timeout')
          assert.ok(existsSync(ready), 'Pi must reach the synthetic provider before interruption');
        const { piPid } = JSON.parse(readFileSync(spawned, 'utf8'));
        assert.throws(() => process.kill(piPid, 0), { code: 'ESRCH' });
      });
    }
    t.diagnostic(
      'pi local-provider turn and version/help, Git repository/hash operations, Node DNS/child spawning passed with only mDNSResponder allowed; syslog needs no exception; Chrome/CDP covered separately',
    );
  },
);
