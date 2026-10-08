// Safety contracts of the web-dapp adapter: launch through the leaf CLI,
// process ownership, the testnet launch gate, launch rollback and the blocked
// host check. test/fixtures/web-dapp-stub-browser.mjs stands in for the slot
// browser, test/fixtures/web-dapp-policy.mjs for the venue policy and
// test/fixtures/web-dapp-test-signer.mjs for a host's extension signer.
// Ported from mm-harness's web-dapp-safety tests; the action checks (app tab
// selection, wallet confirmation guard, HUD) and the host CLI checks stay there.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  assertLaunchNetwork,
  devServerTestnetDiagnostic as diagnoseDevServer,
  hostResolverRules,
  isBlockedUrl,
  launchWebDappBrowser,
  ownerMarker,
  ownsProcess,
  parseWebDappLauncherOutput,
  pidAlive,
  pythonFor,
  resolveBrowser,
  spawnDetached,
  stopWebDappBrowser,
  terminate,
  webDappOnlyLaunchFlags,
} from '../src/web-dapp/index.mjs';
import { writePrivateFile } from '../src/web-dapp/launch.mjs';

import { policy } from './fixtures/web-dapp-policy.mjs';

const require = createRequire(import.meta.url);
const { assertMatch, contains } = require('./fixtures/match.cjs');

// The venue policy web-dapp's leaves read, as an adapter that extends it binds it.
process.env.RECIPE_WEB_DAPP_POLICY = policy.module;
const devServerTestnetDiagnostic = (target, options = {}) =>
  diagnoseDevServer(target, { variable: policy.testnetVariable, ...options });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LAUNCH = path.join(HERE, '../src/web-dapp/launch.mjs');
const STUB_BROWSER = path.join(HERE, 'fixtures/web-dapp-stub-browser.mjs');
const TEST_SIGNER = path.join(HERE, 'fixtures/web-dapp-test-signer.mjs');
// The public Hardhat test mnemonic: no funds, no secret.
const TEST_MNEMONIC = 'test test test test test test test test test test test junk';
const LISTEN =
  "require('http').createServer((q, r) => r.end('ok')).listen(Number(process.argv[1]), '127.0.0.1')";
const started = [];

after(() => {
  for (const pid of started) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
  }
});

function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function track(child) {
  child.unref();
  started.push(child.pid);
  return child.pid;
}

function sleepProcess() {
  return track(spawn('/bin/sleep', ['300'], { detached: true, stdio: 'ignore' }));
}

// Runs node code detached. A node process, because macOS hides the
// environment of platform binaries such as /bin/sleep from ps.
function nodeProcess(code, argv = [], { env = {}, cwd } = {}) {
  return track(
    spawn(process.execPath, ['-e', code, '--', ...argv.map(String)], {
      detached: true,
      stdio: 'ignore',
      cwd,
      env: { ...process.env, ...env },
    }),
  );
}

async function listening(port, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const open = await new Promise((resolve) => {
      const socket = net.connect({ host: '127.0.0.1', port }, () => {
        socket.destroy();
        resolve(true);
      });
      socket.on('error', () => resolve(false));
    });
    if (open) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`nothing listened on ${port}`);
}

const FORCED = { NEXT_PUBLIC_HYPERLIQUID_FORCE_TESTNET: 'true' };

// A slot checkout whose farm next dev server (pid file) listens on the app
// port from the checkout, plus a wallet fixture.
async function slot({ env = FORCED, listen = 'self' } = {}) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'terminal-safety-')));
  mkdirSync(path.join(root, 'temp/farmslot'), { recursive: true });
  const appPort = await freePort();
  let devServer;
  if (listen === 'self') devServer = nodeProcess(LISTEN, [appPort], { env, cwd: root });
  else if (listen === 'child')
    devServer = nodeProcess(
      `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(LISTEN)}, process.argv[1]], { stdio: 'ignore' }); setInterval(() => {}, 1000)`,
      [appPort],
      { env, cwd: root },
    );
  else devServer = nodeProcess('setInterval(() => {}, 1000)', [], { env, cwd: root });
  writeFileSync(path.join(root, 'temp/farmslot/next-dev.pid'), `${devServer}\n`);
  if (listen !== 'none') await listening(appPort);
  const fixture = path.join(root, 'wallet-fixture.json');
  writeFileSync(
    fixture,
    JSON.stringify({
      password: 'correct horse battery',
      accounts: [{ name: 'dev1', type: 'mnemonic', value: TEST_MNEMONIC }],
    }),
    { mode: 0o600 },
  );
  return {
    root,
    appPort,
    devServer,
    runtime: path.join(root, 'temp/recipe/runtime/terminal'),
    fixture,
  };
}

async function launchArgs(s, overrides = {}) {
  return {
    target: s.root,
    'cdp-port': await freePort(),
    'app-port': s.appPort,
    signer: 'injected',
    account: 'dev1',
    headless: true,
    ...overrides,
  };
}

function launchEnv(s, { mode = 'ok', browser = STUB_BROWSER, ...extra } = {}) {
  const env = {
    ...process.env,
    RECIPE_WALLET_FIXTURE: s.fixture,
    TERMINAL_CHROME_BIN: browser,
    STUB_MODE: mode,
    STUB_APP_ORIGIN: `http://localhost:${s.appPort}`,
    ...extra,
  };
  delete env.TERMINAL_HEADLESS;
  return env;
}

function trackPids(runtime) {
  for (const name of ['browser', 'wallet-host']) {
    const file = path.join(runtime, `${name}.pid`);
    if (existsSync(file)) started.push(Number(readFileSync(file, 'utf8').trim()));
  }
}

function stubLog(file) {
  return existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
}

function requestLog(runtime) {
  const file = path.join(runtime, 'wallet-requests.jsonl');
  return existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
}

async function waitUntil(check, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !check())
    await new Promise((resolve) => setTimeout(resolve, 100));
}

function processCommandOf(pid) {
  return spawnSync('ps', ['-ww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).stdout;
}

function processesMatching(pattern) {
  return spawnSync('pgrep', ['-f', pattern], { encoding: 'utf8' }).stdout.trim();
}

const messageOf = (file) => readFileSync(file, 'utf8');

describe('web-dapp launcher on a locked session', () => {
  it('refuses to start or reuse a headful browser before touching the slot', async () => {
    const s = await slot();
    const args = await launchArgs(s, { headless: false, headful: true });
    await assert.rejects(
      launchWebDappBrowser(args, launchEnv(s), { sessionLocked: () => true }),
      /^Error: SESSION_LOCKED: The macOS login session is locked[\s\S]*\nNext: Unlock the Mac/u,
    );
    assert.equal(existsSync(path.join(s.runtime, 'browser.json')), false);
    assert.equal(processesMatching(`--runtime-dir ${s.runtime}`), '');
  });

  it('lets a headful launch through when the session is unlocked or its state unknown', async () => {
    for (const answer of [false, null]) {
      const s = await slot();
      const args = await launchArgs(s, { headless: false, headful: true });
      let probes = 0;
      const state = await launchWebDappBrowser(args, launchEnv(s), {
        sessionLocked: () => {
          probes += 1;
          return answer;
        },
      });
      trackPids(s.runtime);
      assert.equal(probes, 1);
      assert.equal(state.reused, false);
      await stopWebDappBrowser(s.root, { cdpPort: args['cdp-port'] });
    }
  });

  it('launches a headless browser without probing the session', async () => {
    const s = await slot();
    const args = await launchArgs(s);
    let probed = false;
    const state = await launchWebDappBrowser(args, launchEnv(s), {
      sessionLocked: () => {
        probed = true;
        return true;
      },
    });
    trackPids(s.runtime);
    assert.equal(probed, false);
    assert.equal(state.reused, false);
    await stopWebDappBrowser(s.root, { cdpPort: args['cdp-port'] });
  });
});

describe('leaf CLI launch', () => {
  it('parses the launcher summary whether it is compact or indented', () => {
    const summary = { status: 'pass', reused: false, cdpPort: 9541 };
    assert.deepEqual(parseWebDappLauncherOutput(JSON.stringify(summary, null, 2)), summary);
    assert.deepEqual(parseWebDappLauncherOutput(`noise\n${JSON.stringify(summary)}`), summary);
    assertMatch(parseWebDappLauncherOutput(''), { status: 'fail' });
  });

  it('starts and then reuses the slot browser through the launch leaf', async () => {
    const s = await slot();
    const cdpPort = await freePort();
    const env = launchEnv(s);
    const cli = [
      LAUNCH,
      '--target',
      s.root,
      '--cdp-port',
      String(cdpPort),
      '--app-port',
      String(s.appPort),
      '--signer',
      'injected',
      '--headless',
      '--json',
    ];
    const first = spawnSync(process.execPath, cli, { encoding: 'utf8', env, timeout: 120000 });
    trackPids(s.runtime);
    assert.equal(first.status, 0, first.stderr);
    assertMatch(JSON.parse(first.stdout), {
      status: 'pass',
      reused: false,
      signer: 'injected',
      network: 'testnet',
    });
    const second = spawnSync(process.execPath, cli, { encoding: 'utf8', env, timeout: 120000 });
    assert.equal(second.status, 0, second.stderr);
    assertMatch(JSON.parse(second.stdout), { status: 'pass', reused: true });
    const stop = await stopWebDappBrowser(s.root, { cdpPort });
    assert.deepEqual(stop.stopped.map((entry) => entry.name).sort(), ['browser', 'wallet-host']);
  });

  it('forwards the mainnet override and keeps terminal flags to the terminal adapter', () => {
    assert.deepEqual(webDappOnlyLaunchFlags({ signer: 'injected', headless: true, build: true }), [
      '--signer',
      '--headless',
    ]);
    assert.deepEqual(
      webDappOnlyLaunchFlags({ network: 'mainnet', mainnetConfirmation: 'REAL_FUNDS' }),
      ['--network', '--mainnet-confirmation'],
    );
    assert.deepEqual(webDappOnlyLaunchFlags({ build: true }), []);
  });

  it('accepts --network/--mainnet-confirmation on the leaf and refuses mainnet without REAL_FUNDS', async () => {
    const s = await slot();
    const env = launchEnv(s);
    const cli = [
      LAUNCH,
      '--target',
      s.root,
      '--cdp-port',
      String(await freePort()),
      '--app-port',
      String(s.appPort),
      '--signer',
      'injected',
      '--headless',
      '--json',
      '--network',
      'mainnet',
    ];
    const refused = spawnSync(process.execPath, cli, { encoding: 'utf8', env, timeout: 120000 });
    assert.equal(refused.status, 1);
    assert.match(`${refused.stdout}${refused.stderr}`, /mainnet_confirmation=REAL_FUNDS/);
    assert.doesNotMatch(`${refused.stdout}${refused.stderr}`, /unknown (option|flag)/i);
  });
});

describe('process ownership', () => {
  it('never signals a live foreign pid and keeps its pid file; drops a dead pid file', async () => {
    const s = await slot();
    mkdirSync(s.runtime, { recursive: true });
    const foreign = sleepProcess();
    writeFileSync(path.join(s.runtime, 'browser.pid'), `${foreign}\n`);
    writeFileSync(path.join(s.runtime, 'wallet-host.pid'), '999999\n');
    const result = await stopWebDappBrowser(s.root);
    assert.equal(pidAlive(foreign), true);
    assert.deepEqual(result.stopped, []);
    assert.deepEqual(result.foreign, [{ name: 'browser', pid: foreign }]);
    assert.deepEqual(result.stale, [{ name: 'wallet-host', pid: 999999 }]);
    assert.equal(existsSync(path.join(s.runtime, 'browser.pid')), true);
    assert.equal(existsSync(path.join(s.runtime, 'wallet-host.pid')), false);
  });

  it('never signals another slot whose runtime dir shares a prefix or a space-separated suffix', async () => {
    const s = await slot();
    mkdirSync(s.runtime, { recursive: true });
    for (const other of [`${s.runtime}2`, `${s.runtime} backup`]) {
      const neighbour = nodeProcess('setInterval(() => {}, 1000)', [
        '/elsewhere/adapters/web-dapp/wallet-host.mjs',
        '--runtime-dir',
        other,
        ownerMarker('wallet-host', other),
      ]);
      await waitUntil(() =>
        processCommandOf(neighbour).includes(ownerMarker('wallet-host', other)),
      );
      assert.equal(ownsProcess('wallet-host', neighbour, s.runtime), false);
      writeFileSync(path.join(s.runtime, 'wallet-host.pid'), `${neighbour}\n`);
      const result = await stopWebDappBrowser(s.root);
      assert.equal(pidAlive(neighbour), true);
      assert.deepEqual(result.foreign, [{ name: 'wallet-host', pid: neighbour }]);
    }
  });

  it('stops a process whose command line proves it is the slot browser', async () => {
    const s = await slot();
    mkdirSync(s.runtime, { recursive: true });
    const browser = nodeProcess('setInterval(() => {}, 1000)', [
      `--user-data-dir=${s.runtime}/profile-injected-dev1`,
      ownerMarker('browser', s.runtime),
    ]);
    await waitUntil(() => processCommandOf(browser).includes(ownerMarker('browser', s.runtime)));
    assert.equal(ownsProcess('browser', browser, s.runtime), true);
    writeFileSync(path.join(s.runtime, 'browser.pid'), `${browser}\n`);
    const result = await stopWebDappBrowser(s.root);
    assert.deepEqual(result.stopped, [{ name: 'browser', pid: browser }]);
    assert.equal(pidAlive(browser), false);
  });

  it('starts and stops the same slot through a symlinked and a real checkout path', async () => {
    const s = await slot();
    const link = path.join(mkdtempSync(path.join(os.tmpdir(), 'terminal-link-')), 'slot');
    symlinkSync(s.root, link);
    for (const [startPath, stopPath] of [
      [link, s.root],
      [s.root, link],
    ]) {
      const args = await launchArgs(s, { target: startPath });
      await launchWebDappBrowser(args, launchEnv(s));
      trackPids(s.runtime);
      const result = await stopWebDappBrowser(stopPath, { cdpPort: args['cdp-port'] });
      assert.deepEqual(result.stopped.map((entry) => entry.name).sort(), [
        'browser',
        'wallet-host',
      ]);
      assert.equal(result.cdpPortFree, true);
    }
  });

  it('kills the whole process group, including children that ignore SIGTERM', async () => {
    const leader = nodeProcess(
      "require('child_process').spawn('/bin/sh', ['-c', 'trap \"\" TERM; while :; do sleep 1; done'], { stdio: 'ignore' }); setInterval(() => {}, 1000)",
    );
    const group = () =>
      spawnSync('pgrep', ['-g', String(leader)], { encoding: 'utf8' }).stdout.trim();
    await waitUntil(() => group().split('\n').length > 1);
    assert.ok(group().split('\n').length > 1);
    await terminate(leader, 500);
    assert.equal(
      spawnSync('pgrep', ['-g', String(leader)], { encoding: 'utf8' }).stdout.trim(),
      '',
    );
  });
});

// The diagnostic reads a process's argv and environment through macOS sysctl
// (KERN_PROCARGS2); elsewhere it reports unknown, an advisory warning.
const MACOS_ONLY =
  process.platform !== 'darwin' && 'reads process environments through macOS sysctl';
describe('dev server testnet diagnostic (advisory)', () => {
  it('passes for the farm next dev, or its child, serving the app port from this checkout', async (t) => {
    if (MACOS_ONLY) return t.skip(MACOS_ONLY);
    const devArgv = (port) => ['next', 'dev', port];
    for (const listen of ['self', 'child']) {
      const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'terminal-diag-')));
      mkdirSync(path.join(root, 'temp/farmslot'), { recursive: true });
      const appPort = await freePort();
      const code =
        listen === 'self'
          ? `${LISTEN.replace('process.argv[1]', 'process.argv[3]')}`
          : `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(LISTEN)}, process.argv[3]], { stdio: 'ignore' }); setInterval(() => {}, 1000)`;
      const server = nodeProcess(code, devArgv(appPort), { env: FORCED, cwd: root });
      writeFileSync(path.join(root, 'temp/farmslot/next-dev.pid'), `${server}\n`);
      await listening(appPort);
      assertMatch(devServerTestnetDiagnostic(root, { appPort }), { known: true, forced: true });
    }
  });

  it('fails safe where process environments cannot be read: unknown, never forced', async (t) => {
    if (!MACOS_ONLY) return t.skip('macOS reads process environments');
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'terminal-diag-')));
    mkdirSync(path.join(root, 'temp/farmslot'), { recursive: true });
    const appPort = await freePort();
    const listen = LISTEN.replace('process.argv[1]', 'process.argv[3]');
    const server = nodeProcess(listen, ['next', 'dev', appPort], { env: FORCED, cwd: root });
    writeFileSync(path.join(root, 'temp/farmslot/next-dev.pid'), `${server}\n`);
    await listening(appPort);
    const diagnostic = devServerTestnetDiagnostic(root, { appPort });
    assert.equal(diagnostic.known, false);
    assert.notEqual(diagnostic.forced, true);
  });

  it('warns for the three reproduced bypasses: an unforced child, a lookalike variable, and next start', async (t) => {
    if (MACOS_ONLY) return t.skip(MACOS_ONLY);
    // A forced parent whose listening child runs with testnet off.
    const parentRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'terminal-diag-')));
    mkdirSync(path.join(parentRoot, 'temp/farmslot'), { recursive: true });
    const port1 = await freePort();
    const parent = nodeProcess(
      `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(LISTEN)}, process.argv[3]], { stdio: 'ignore', env: { ...process.env, NEXT_PUBLIC_HYPERLIQUID_FORCE_TESTNET: 'false' } }); setInterval(() => {}, 1000)`,
      ['next', 'dev', port1],
      { env: FORCED, cwd: parentRoot },
    );
    writeFileSync(path.join(parentRoot, 'temp/farmslot/next-dev.pid'), `${parent}\n`);
    await listening(port1);
    assertMatch(devServerTestnetDiagnostic(parentRoot, { appPort: port1 }), {
      known: true,
      forced: false,
    });

    // An unrelated variable whose value contains the token, the flag unset.
    const lookalikeRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'terminal-diag-')));
    mkdirSync(path.join(lookalikeRoot, 'temp/farmslot'), { recursive: true });
    const port2 = await freePort();
    const env = { ...process.env, LOOKALIKE: 'x NEXT_PUBLIC_HYPERLIQUID_FORCE_TESTNET=true' };
    delete env.NEXT_PUBLIC_HYPERLIQUID_FORCE_TESTNET;
    const lookalike = track(
      spawn(
        process.execPath,
        [
          '-e',
          LISTEN.replace('process.argv[1]', 'process.argv[3]'),
          '--',
          'next',
          'dev',
          String(port2),
        ],
        { detached: true, stdio: 'ignore', cwd: lookalikeRoot, env },
      ),
    );
    writeFileSync(path.join(lookalikeRoot, 'temp/farmslot/next-dev.pid'), `${lookalike}\n`);
    await listening(port2);
    assertMatch(devServerTestnetDiagnostic(lookalikeRoot, { appPort: port2 }), {
      known: true,
      forced: false,
    });

    // Both pid files pointing at a production server.
    const startRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'terminal-diag-')));
    mkdirSync(path.join(startRoot, 'temp/farmslot'), { recursive: true });
    const port3 = await freePort();
    const production = nodeProcess(
      LISTEN.replace('process.argv[1]', 'process.argv[3]'),
      ['next', 'start', port3],
      { env: FORCED, cwd: startRoot },
    );
    for (const file of ['next-dev.pid', 'next-start.pid'])
      writeFileSync(path.join(startRoot, 'temp/farmslot', file), `${production}\n`);
    await listening(port3);
    assertMatch(devServerTestnetDiagnostic(startRoot, { appPort: port3 }), {
      known: true,
      forced: false,
      detail: contains('next start'),
    });
  });

  it('allows mainnet only with the real-funds confirmation', () => {
    const bare = mkdtempSync(path.join(os.tmpdir(), 'terminal-mainnet-'));
    assert.throws(() => assertLaunchNetwork(bare, { network: 'mainnet' }), /REAL_FUNDS/);
    assert.equal(
      assertLaunchNetwork(bare, { network: 'mainnet', mainnetConfirmation: 'REAL_FUNDS' }),
      'mainnet',
    );
    assert.throws(() => assertLaunchNetwork(bare, { network: 'devnet' }), /testnet or mainnet/);
    assert.equal(assertLaunchNetwork(bare), 'testnet');
  });
});

describe('private file writes', () => {
  it('removes the temporary file when the rename fails, and keeps the destination', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'web-dapp-private-file-'));
    const destination = path.join(dir, 'wallet-fixture.json');
    // A directory at the destination makes the rename fail after the write.
    mkdirSync(destination);
    assert.throws(() => writePrivateFile(destination, '{"key":"secret"}'));
    assert.deepEqual(readdirSync(dir), ['wallet-fixture.json']);
    assert.equal(statSync(destination).isDirectory(), true);
  });

  it('removes the temporary file when the write fails', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'web-dapp-private-file-'));
    assert.throws(() => writePrivateFile(path.join(dir, 'missing', 'file.json'), 'secret'));
    assert.deepEqual(readdirSync(dir), []);
  });

  it('writes owner-only and leaves no temporary file on success', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'web-dapp-private-file-'));
    const destination = path.join(dir, 'state.json');
    writePrivateFile(destination, 'ok');
    assert.equal(readFileSync(destination, 'utf8'), 'ok');
    assert.equal(statSync(destination).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(dir), ['state.json']);
  });
});

describe('wallet host: first document, duplicates, frames and popups', () => {
  async function launchProbe(mode) {
    const s = await slot();
    const args = await launchArgs(s);
    const log = path.join(s.root, 'stub-cdp.jsonl');
    const launched = launchWebDappBrowser(args, launchEnv(s, { mode, STUB_LOG: log }), {
      timeouts: { browserStartMs: 15000, hostReadyMs: 20000 },
    });
    return { s, args, log, launched };
  }

  it('logs the first app document, answers only its top frame, and refuses an iframe and a blank popup with 4100', async () => {
    const { s, args, log, launched } = await launchProbe('probe');
    await launched;
    trackPids(s.runtime);
    const commands = () => stubLog(log);
    await waitUntil(
      () =>
        commands().filter((entry) => entry.method === 'Runtime.evaluate' && entry.contextId != null)
          .length >= 3,
    );
    // Hooks went in before the tab navigated to the app.
    const order = commands().map((entry) => entry.method);
    assert.ok(order.indexOf('Runtime.addBinding') < order.indexOf('Page.navigate'));
    assert.ok(commands().find((entry) => entry.method === 'Target.createTarget'));
    const resolves = commands().filter(
      (entry) => entry.method === 'Runtime.evaluate' && entry.contextId != null,
    );
    assert.deepEqual(
      resolves.filter((entry) => !entry.refused).map((entry) => entry.contextId),
      [2],
    );
    assert.deepEqual(
      resolves
        .filter((entry) => entry.refused)
        .map((entry) => entry.contextId)
        .sort(),
      [3, 30],
    );
    assert.deepEqual(
      requestLog(s.runtime)
        .filter((entry) => entry.kind === 'request')
        .map((entry) => entry.method),
      ['eth_requestAccounts'],
    );
    assert.equal(statSync(path.join(s.runtime, 'wallet-requests.jsonl')).mode & 0o777, 0o600);
    await stopWebDappBrowser(s.root, { cdpPort: args['cdp-port'] });
  });

  it('gives the injected strict wallet the identity the signer module names', async () => {
    const s = await slot();
    const log = path.join(s.root, 'stub-cdp.jsonl');
    const args = await launchArgs(s, { 'signer-module': TEST_SIGNER });
    await launchWebDappBrowser(args, launchEnv(s, { mode: 'probe', STUB_LOG: log }), {
      timeouts: { browserStartMs: 15000, hostReadyMs: 20000 },
    });
    trackPids(s.runtime);
    const sources = stubLog(log)
      .filter((entry) => entry.method === 'Page.addScriptToEvaluateOnNewDocument')
      .map((entry) => entry.source);
    assert.ok(sources.length > 0);
    for (const source of sources) {
      assert.match(source, /io\.example\.test-host-wallet/u);
      assert.doesNotMatch(source, /io\.farmslot\.strict-wallet/u);
    }
    await stopWebDappBrowser(s.root, { cdpPort: args['cdp-port'] });
  });

  it('hooks a tab once even when it is attached twice, and closes restored app tabs', async () => {
    const { s, args, log, launched } = await launchProbe('restored');
    await launched;
    trackPids(s.runtime);
    await waitUntil(() => requestLog(s.runtime).some((entry) => entry.kind === 'request'));
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.deepEqual(
      requestLog(s.runtime)
        .filter((entry) => entry.kind === 'request')
        .map((entry) => entry.method),
      ['eth_requestAccounts'],
    );
    const commands = stubLog(log);
    assert.equal(
      commands.some((entry) => entry.method === 'Runtime.addBinding' && entry.sessionId === 'S2'),
      false,
    );
    assert.equal(
      commands.some((entry) => entry.method === 'Target.closeTarget' && entry.targetId === 'OLD'),
      true,
    );
    await stopWebDappBrowser(s.root, { cdpPort: args['cdp-port'] });
  });

  it('fails the launch, and rolls it back, when the app document has no log binding', async () => {
    const { s, launched } = await launchProbe('no-binding');
    await assert.rejects(launched, /wallet host (ready|exited before it was ready)/);
    assert.equal(processesMatching(`--user-data-dir=${s.runtime}/profile-`), '');
    assert.equal(processesMatching(`--runtime-dir ${s.runtime}`), '');
  });
});

describe('testnet enforced in the browser (round 3)', () => {
  const quick = { timeouts: { browserStartMs: 15000, hostReadyMs: 30000 } };
  const probeLaunch = async (mode, overrides = {}) => {
    const s = await slot();
    const args = await launchArgs(s, overrides);
    const log = path.join(s.root, 'stub-cdp.jsonl');
    const launched = launchWebDappBrowser(args, launchEnv(s, { mode, STUB_LOG: log }), quick);
    return { s, args, log, launched };
  };

  it('blocks and logs a mainnet request from the app, refuses its mainnet signature, and fails the launch', async () => {
    const { s, log, launched } = await probeLaunch('mainnet-app');
    await assert.rejects(launched, /wallet host exited before it was ready|wallet host ready/);
    const entries = requestLog(s.runtime);
    assert.deepEqual(
      entries
        .filter((entry) => entry.kind === 'blocked-mainnet' && !entry.probe)
        .map((entry) => entry.url),
      ['https://api.hyperliquid.xyz/exchange'],
    );
    assert.equal(entries.filter((entry) => entry.kind === 'refused-mainnet').length, 1);
    assert.equal(
      entries.some((entry) => entry.kind === 'network-enforcement'),
      false,
    );
    const commands = stubLog(log);
    assert.equal(
      commands.some(
        (entry) => entry.method === 'Fetch.failRequest' && entry.requestId === 'MAINNET-1',
      ),
      true,
    );
    // The signature request was answered with a refusal, never signed.
    assert.equal(
      commands
        .filter((entry) => entry.method === 'Runtime.evaluate' && entry.contextId === 2)
        .every((entry) => entry.refused),
      true,
    );
    assert.match(messageOf(path.join(s.runtime, 'wallet-host.log')), /requested the mainnet venue/);
    assert.equal(processesMatching(`--runtime-dir ${s.runtime}`), '');
  });

  // A policy that declares no served hosts: the app's page makes no venue requests.
  const noServedLaunch = async (mode, { optOut = true, servedTimeoutMs } = {}) => {
    const s = await slot();
    writeFileSync(
      path.join(s.root, 'venue-hosts.json'),
      JSON.stringify({
        blocked: ['api.hyperliquid.xyz', 'rpc.hyperliquid.xyz'],
        served: [],
        ...(optOut ? { servedCheck: 'not-applicable' } : {}),
      }),
    );
    const args = await launchArgs(s);
    const log = path.join(s.root, 'stub-cdp.jsonl');
    const launched = launchWebDappBrowser(
      args,
      launchEnv(s, {
        mode,
        STUB_LOG: log,
        ...(servedTimeoutMs ? { MM_HARNESS_SERVED_TIMEOUT_MS: servedTimeoutMs } : {}),
      }),
      quick,
    );
    return { s, args, log, launched };
  };

  it('skips the served-network check when the policy declares no served hosts, and says so', async () => {
    const { s, args, launched } = await noServedLaunch('ok');
    const state = await launched;
    trackPids(s.runtime);
    assertMatch(state.networkEnforcement, {
      mode: 'enforced',
      served: 'not-applicable',
      mainnetHosts: ['api.hyperliquid.xyz', 'rpc.hyperliquid.xyz'],
      testnetHosts: [],
    });
    assert.equal(state.networkEnforcement.layers.includes('served-network-check'), false);
    assertMatch(
      requestLog(s.runtime).find((entry) => entry.kind === 'network-enforcement'),
      { enforcement: 'enforced', served: 'not-applicable', servedHosts: [] },
    );
    await stopWebDappBrowser(s.root, { cdpPort: args['cdp-port'] });
  });

  it('still blocks and fails on mainnet traffic when the served check is not applicable', async () => {
    const { s, launched } = await noServedLaunch('mainnet-app');
    await assert.rejects(launched, /wallet host exited before it was ready|wallet host ready/);
    assert.match(messageOf(path.join(s.runtime, 'wallet-host.log')), /requested the mainnet venue/);
    assert.deepEqual(
      requestLog(s.runtime)
        .filter((entry) => entry.kind === 'blocked-mainnet' && !entry.probe)
        .map((entry) => entry.url),
      ['https://api.hyperliquid.xyz/exchange'],
    );
  });

  it('keeps the served-network check, failing closed, when a policy finds no served hosts but does not opt out', async () => {
    const { s, launched } = await noServedLaunch('ok', { optOut: false, servedTimeoutMs: '1500' });
    await assert.rejects(launched, /wallet host exited before it was ready|wallet host ready/);
    assert.match(messageOf(path.join(s.runtime, 'wallet-host.log')), /testnet venue endpoint/);
  });

  it('refuses a policy that lists served hosts and also opts out of the served check', async () => {
    const s = await slot();
    writeFileSync(
      path.join(s.root, 'venue-hosts.json'),
      JSON.stringify({
        blocked: ['api.hyperliquid.xyz'],
        served: ['api.hyperliquid-testnet.xyz'],
        servedCheck: 'not-applicable',
      }),
    );
    const args = await launchArgs(s);
    await assert.rejects(
      launchWebDappBrowser(args, launchEnv(s, { mode: 'ok' }), quick),
      /lists served testnet hosts and servedCheck: 'not-applicable'; declare one or the other/,
    );
  });

  it('keeps the served-network check, and its record, for a policy that declares served hosts', async () => {
    const { s, args, launched } = await probeLaunch('ok');
    const state = await launched;
    trackPids(s.runtime);
    assert.equal('served' in state.networkEnforcement, false);
    assert.ok(state.networkEnforcement.layers.includes('served-network-check'));
    const entry = requestLog(s.runtime).find((item) => item.kind === 'network-enforcement');
    assert.equal('served' in entry, false);
    await stopWebDappBrowser(s.root, { cdpPort: args['cdp-port'] });
  });

  it('probes a venue whose policy paths hold a quote: the exact URLs, blocked, no page SyntaxError', async (t) => {
    const s = await slot();
    // The files this test adds live in a directory it removes, whether or not the launch passes.
    const own = mkdtempSync(path.join(os.tmpdir(), 'web-dapp-quote-'));
    t.after(() => rmSync(own, { recursive: true, force: true }));
    // The test policy with probe paths a single-quoted page expression would break on. It
    // imports a copy of the fixture beside it: the policy fence takes relative imports only.
    copyFileSync(policy.module, path.join(own, 'base-policy.mjs'));
    const quoted = path.join(own, 'quote-policy.mjs');
    writeFileSync(
      quoted,
      `import { policy as base } from './base-policy.mjs';\n` +
        `export const policy = { ...base, probe: { ...base.probe, httpPath: "/info'x", wsPath: "/ws'x" } };\n`,
    );
    const probeLog = path.join(own, 'probe-urls.jsonl');
    const args = await launchArgs(s);
    const launched = launchWebDappBrowser(
      args,
      launchEnv(s, { mode: 'ok', RECIPE_WEB_DAPP_POLICY: quoted, STUB_PROBE_LOG: probeLog }),
      quick,
    );
    const state = await launched;
    trackPids(s.runtime);
    assert.equal(state.networkEnforcement.mode, 'enforced');
    assert.ok(state.networkEnforcement.layers.includes('cdp-fetch-block'));
    // The page requested the policy paths verbatim, quote included.
    assert.deepEqual(
      readFileSync(probeLog, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
      [
        "https://api.hyperliquid.xyz/info'x?mm-harness-probe=1",
        "https://api.hyperliquid.xyz:444/info'x?mm-harness-probe=1",
        "wss://api.hyperliquid.xyz/ws'x?mm-harness-probe=1",
      ],
    );
    await stopWebDappBrowser(s.root, { cdpPort: args['cdp-port'] });
  });

  it('fails the launch when the mainnet probe gets through', async () => {
    const { s, launched } = await probeLaunch('probe-reaches');
    await assert.rejects(launched, /wallet host/);
    assert.match(messageOf(path.join(s.runtime, 'wallet-host.log')), /mainnet venue is reachable/);
  });

  it('passes the venue block list to the browser and records enforcement; REAL_FUNDS mainnet disables it', async () => {
    const testnet = await probeLaunch('ok');
    const state = await testnet.launched;
    trackPids(testnet.s.runtime);
    assertMatch(state.networkEnforcement, {
      mode: 'enforced',
      mainnetHosts: ['api.hyperliquid.xyz', 'rpc.hyperliquid.xyz'],
    });
    assert.ok(
      processCommandOf(state.browserPid).includes(
        '--host-resolver-rules=MAP api.hyperliquid.xyz ~NOTFOUND, MAP api.hyperliquid.xyz. ~NOTFOUND, MAP rpc.hyperliquid.xyz ~NOTFOUND, MAP rpc.hyperliquid.xyz. ~NOTFOUND',
      ),
    );
    assertMatch(
      requestLog(testnet.s.runtime).find((entry) => entry.kind === 'network-enforcement'),
      { enforcement: 'enforced', servedHosts: ['api.hyperliquid-testnet.xyz'] },
    );
    await stopWebDappBrowser(testnet.s.root, { cdpPort: testnet.args['cdp-port'] });

    const mainnet = await probeLaunch('ok', {
      network: 'mainnet',
      'mainnet-confirmation': 'REAL_FUNDS',
    });
    const mainnetState = await mainnet.launched;
    trackPids(mainnet.s.runtime);
    assertMatch(mainnetState.networkEnforcement, { mode: 'disabled' });
    assert.equal(
      processCommandOf(mainnetState.browserPid).includes('--host-resolver-rules'),
      false,
    );
    assertMatch(
      requestLog(mainnet.s.runtime).find((entry) => entry.kind === 'network-enforcement'),
      { enforcement: 'disabled' },
    );
    await stopWebDappBrowser(mainnet.s.root, { cdpPort: mainnet.args['cdp-port'] });
  });

  it('fails and rolls back when the page script cannot be installed', async () => {
    const { s, launched } = await probeLaunch('reject-preload');
    await assert.rejects(launched, /wallet host/);
    assert.match(
      messageOf(path.join(s.runtime, 'wallet-host.log')),
      /stub refused the page script/,
    );
    assert.equal(processesMatching(`--user-data-dir=${s.runtime}/profile-`), '');
    assert.equal(processesMatching(`--runtime-dir ${s.runtime}`), '');
  });

  it('logs an early call from a newly attached app tab once its committed URL is known', async () => {
    const { s, args, launched } = await probeLaunch('early-log');
    await launched;
    trackPids(s.runtime);
    await waitUntil(() => requestLog(s.runtime).some((entry) => entry.kind === 'request'));
    await new Promise((resolve) => setTimeout(resolve, 800));
    assert.deepEqual(
      requestLog(s.runtime)
        .filter((entry) => entry.kind === 'request')
        .map((entry) => entry.method),
      ['wallet_requestPermissions'],
    );
    assert.equal(
      requestLog(s.runtime).some((entry) => entry.kind === 'unattributed'),
      false,
    );
    await stopWebDappBrowser(s.root, { cdpPort: args['cdp-port'] });
  });

  it('stops waiting for ready as soon as the wallet host exits', async () => {
    const s = await slot();
    const startedAt = Date.now();
    await assert.rejects(
      launchWebDappBrowser(await launchArgs(s), launchEnv(s, { mode: 'http-only' }), {
        timeouts: { browserStartMs: 15000, hostReadyMs: 120000 },
      }),
      /exited before it was ready/,
    );
    // Well short of the 120 s ready budget, even on a loaded machine.
    assert.ok(Date.now() - startedAt < 80000);
  });

  it('kills the child and rejects when its pid file cannot be written', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'terminal-eisdir-'));
    mkdirSync(path.join(dir, 'child.pid'));
    await assert.rejects(
      spawnDetached(
        process.execPath,
        ['-e', 'setInterval(() => {}, 1000)', '--', `--mm-eisdir-${process.pid}`],
        { logFile: path.join(dir, 'child.log'), pidFile: path.join(dir, 'child.pid') },
      ),
      /could not record node pid/,
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(processesMatching(`--mm-eisdir-${process.pid}`), '');
  });
});

describe('round 4: enforcement identity, venue endpoints, probes and attribution', () => {
  const quick = { timeouts: { browserStartMs: 15000, hostReadyMs: 30000 } };
  const probeLaunch = async (mode, overrides = {}, s = null, extraEnv = {}) => {
    const slotDir = s ?? (await slot());
    const args = await launchArgs(slotDir, overrides);
    const log = path.join(slotDir.root, 'stub-cdp.jsonl');
    const launched = launchWebDappBrowser(
      args,
      launchEnv(slotDir, { mode, STUB_LOG: log, ...extraEnv }),
      quick,
    );
    return { s: slotDir, args, log, launched };
  };

  it('ignores a coin icon on app.hyperliquid.xyz and never creates a foreground tab', async () => {
    const { s, args, log, launched } = await probeLaunch('icon');
    const state = await launched;
    trackPids(s.runtime);
    assertMatch(
      requestLog(s.runtime).find((entry) => entry.kind === 'network-enforcement'),
      {
        servedHosts: ['api.hyperliquid-testnet.xyz'],
        probes: {
          http: 'net::ERR_BLOCKED_BY_CLIENT other',
          resolver: 'net::ERR_NAME_NOT_RESOLVED',
        },
      },
    );
    assert.equal(state.networkEnforcement.mainnetHosts.includes('app.hyperliquid.xyz'), false);
    assert.equal(
      stubLog(log)
        .filter((entry) => entry.method === 'Target.createTarget')
        .every((entry) => entry.background === true),
      true,
    );
    await stopWebDappBrowser(s.root, { cdpPort: args['cdp-port'] });
  });

  it('fails the launch when the HTTP probe fails for another reason than the request block (CORS)', async () => {
    const { s, launched } = await probeLaunch('probe-cors');
    await assert.rejects(launched, /wallet host/);
    assert.match(
      messageOf(path.join(s.runtime, 'wallet-host.log')),
      /HTTP probe failed, but not by the request block \(net::ERR_FAILED/,
    );
  });

  it('fails the launch when the resolver probe does not fail at name resolution', async () => {
    const { s, launched } = await probeLaunch('no-resolver');
    await assert.rejects(launched, /wallet host/);
    assert.match(
      messageOf(path.join(s.runtime, 'wallet-host.log')),
      /resolver probe failed, but not by the host resolver rule \(net::ERR_CONNECTION_REFUSED\)/,
    );
  });

  it('fails the launch when the HTTP probe is blocked by something other than this host', async () => {
    const { s, launched } = await probeLaunch('probe-other-blocker');
    await assert.rejects(launched, /wallet host/);
    assert.match(
      messageOf(path.join(s.runtime, 'wallet-host.log')),
      /HTTP probe failed, but not by the request block \(net::ERR_BLOCKED_BY_CLIENT other; failed here: false\)/,
    );
  });

  it('never takes a request to the venue web host as proof of the served network (Claude round 8)', async () => {
    const s = await slot();
    const args = await launchArgs(s);
    const launched = launchWebDappBrowser(
      args,
      launchEnv(s, { mode: 'link-only', MM_HARNESS_SERVED_TIMEOUT_MS: '1500' }),
      quick,
    );
    await assert.rejects(launched, /wallet host/);
    assert.match(
      messageOf(path.join(s.runtime, 'wallet-host.log')),
      /the app made no request to a testnet venue endpoint/u,
    );
    assert.equal(processesMatching(`--runtime-dir ${s.runtime}`), '');
  });

  it('says why the app tab never committed its first page (Codex round 7)', async () => {
    const s = await slot();
    const args = await launchArgs(s);
    const launched = launchWebDappBrowser(
      args,
      launchEnv(s, { mode: 'no-commit', MM_HARNESS_APP_COMMIT_TIMEOUT_MS: '1500' }),
      quick,
    );
    await assert.rejects(launched, /wallet host/);
    assert.match(
      messageOf(path.join(s.runtime, 'wallet-host.log')),
      /the app tab did not commit http:\/\/localhost:\d+\/order\/BTC: navigate answered loader set; commits \[none\]; document no response seen; tab now at about:blank; dev server (?:HTTP \d+|unreachable|no answer in 5 s)/u,
    );
    assert.equal(processesMatching(`--runtime-dir ${s.runtime}`), '');
  });

  it('judges a call made before its document commits against that document, not the previous commit', async () => {
    const { s, args, launched } = await probeLaunch('stale-commit');
    await launched;
    trackPids(s.runtime);
    await waitUntil(() => requestLog(s.runtime).some((entry) => entry.kind === 'request'));
    assert.deepEqual(
      requestLog(s.runtime)
        .filter((entry) => entry.kind === 'request')
        .map((entry) => entry.method),
      ['eth_requestAccounts'],
    );
    assert.deepEqual(
      requestLog(s.runtime).filter((entry) =>
        ['unattributed', 'outside-app-frame'].includes(entry.kind),
      ),
      [],
    );
    await stopWebDappBrowser(s.root, { cdpPort: args['cdp-port'] });
  });

  it('never reuses a browser that skips the served check for a launch that needs it', async () => {
    const s = await slot();
    const cdpPort = await freePort();
    const hosts = (extra) =>
      writeFileSync(
        path.join(s.root, 'venue-hosts.json'),
        JSON.stringify({
          blocked: ['api.hyperliquid.xyz', 'rpc.hyperliquid.xyz'],
          served: [],
          ...extra,
        }),
      );
    hosts({ servedCheck: 'not-applicable' });
    const first = await (await probeLaunch('ok', { 'cdp-port': cdpPort }, s)).launched;
    trackPids(s.runtime);
    assert.equal(first.networkEnforcement.served, 'not-applicable');
    // The policy now finds no served hosts but no longer opts out: a fresh browser
    // whose wallet host runs the check, which fails closed.
    hosts({});
    await assert.rejects(
      (
        await probeLaunch('ok', { 'cdp-port': cdpPort }, s, {
          MM_HARNESS_SERVED_TIMEOUT_MS: '1500',
        })
      ).launched,
      /wallet host exited before it was ready|wallet host ready/,
    );
    assert.equal(pidAlive(first.browserPid), false);
    await stopWebDappBrowser(s.root, { cdpPort });
  });

  it('reuses the browser only while it enforces the same venue host list', async () => {
    const s = await slot();
    const cdpPort = await freePort();
    const first = await (await probeLaunch('ok', { 'cdp-port': cdpPort }, s)).launched;
    trackPids(s.runtime);
    assert.equal(first.reused, false);
    assert.equal(
      (await (await probeLaunch('ok', { 'cdp-port': cdpPort }, s)).launched).reused,
      true,
    );
    // The venue policy names a new mainnet endpoint.
    writeFileSync(
      path.join(s.root, 'venue-hosts.json'),
      JSON.stringify({
        blocked: ['api-ui.hyperliquid.xyz', 'api.hyperliquid.xyz', 'rpc.hyperliquid.xyz'],
        served: ['api.hyperliquid-testnet.xyz'],
      }),
    );
    const relaunched = await (await probeLaunch('ok', { 'cdp-port': cdpPort }, s)).launched;
    trackPids(s.runtime);
    assert.equal(relaunched.reused, false);
    assert.ok(relaunched.networkEnforcement.mainnetHosts.includes('api-ui.hyperliquid.xyz'));
    assert.notEqual(
      relaunched.networkEnforcement.fingerprint,
      first.networkEnforcement.fingerprint,
    );
    assert.ok(
      processCommandOf(relaunched.browserPid).includes('MAP api-ui.hyperliquid.xyz ~NOTFOUND'),
    );
    assert.equal(pidAlive(first.browserPid), false);
    await stopWebDappBrowser(s.root, { cdpPort });
  });

  it('applies a commit reported by both frameNavigated and getFrameTree once, so the next document is judged on its own commit', async () => {
    // Codex round 5: the blank tab's commit, consumed twice, left about:blank
    // waiting for the app document's context.
    const { s, args, launched } = await probeLaunch('double-commit');
    await launched;
    trackPids(s.runtime);
    await waitUntil(() => requestLog(s.runtime).some((entry) => entry.kind === 'request'));
    assert.deepEqual(
      requestLog(s.runtime)
        .filter((entry) => entry.kind === 'request')
        .map((entry) => entry.method),
      ['eth_requestAccounts'],
    );
    assert.deepEqual(
      requestLog(s.runtime).filter((entry) =>
        ['unattributed', 'outside-app-frame'].includes(entry.kind),
      ),
      [],
    );
    await stopWebDappBrowser(s.root, { cdpPort: args['cdp-port'] });
  });

  it('records calls still waiting for their document as unattributed when the tab detaches', async () => {
    const { s, args, launched } = await probeLaunch('detach-pending');
    await launched;
    trackPids(s.runtime);
    await waitUntil(() => requestLog(s.runtime).some((entry) => entry.kind === 'unattributed'));
    assertMatch(
      requestLog(s.runtime).filter((entry) => entry.kind === 'unattributed'),
      [{ binding: 'log', method: 'wallet_requestPermissions', reason: 'its tab detached first' }],
    );
    await stopWebDappBrowser(s.root, { cdpPort: args['cdp-port'] });
  });

  it('blocks a host in its canonical form, in the request block and the resolver rule', () => {
    for (const url of [
      'https://API.hyperliquid.xyz/info',
      'wss://api.hyperliquid.xyz.:443/ws',
      'https://api.hyperliquid.xyz:443/x/../info',
    ]) {
      assert.equal(isBlockedUrl(url, ['api.hyperliquid.xyz']), true, url);
    }
    assert.equal(
      isBlockedUrl('https://api.hyperliquid.xyz.evil.example/info', ['api.hyperliquid.xyz']),
      false,
    );
    assert.equal(
      hostResolverRules(['api.example']),
      '--host-resolver-rules=MAP api.example ~NOTFOUND, MAP api.example. ~NOTFOUND',
    );
  });

  it('honours only TERMINAL_CHROME_BIN, never the shared RECIPE_HARNESS_CHROME_BIN', async () => {
    const browser = await resolveBrowser(
      { RECIPE_HARNESS_CHROME_BIN: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser' },
      [STUB_BROWSER],
    );
    assertMatch(browser, { bin: STUB_BROWSER, source: 'chrome-for-testing' });
    assertMatch(await resolveBrowser({ TERMINAL_CHROME_BIN: STUB_BROWSER }, []), {
      source: 'TERMINAL_CHROME_BIN',
    });
  });

  it('never runs the macOS python3 stub without developer tools (its install dialog takes focus)', () => {
    assert.equal(
      pythonFor({ found: '/usr/bin/python3', platform: 'darwin', developerDir: () => '' }),
      null,
    );
    assert.equal(
      pythonFor({
        found: '/usr/bin/python3',
        platform: 'darwin',
        developerDir: () => '/Library/Developer/CommandLineTools',
      }),
      '/usr/bin/python3',
    );
    assert.equal(
      pythonFor({ found: '/opt/homebrew/bin/python3', platform: 'darwin', developerDir: () => '' }),
      '/opt/homebrew/bin/python3',
    );
    assert.equal(pythonFor({ found: '', platform: 'darwin', developerDir: () => '' }), null);
  });
});

describe('launch rollback', () => {
  const fast = { timeouts: { browserStartMs: 4000, hostReadyMs: 6000 } };

  it('stops a browser that never opens its CDP port and tightens the runtime dir', async () => {
    const s = await slot();
    mkdirSync(s.runtime, { recursive: true, mode: 0o755 });
    chmodSync(s.runtime, 0o755);
    await assert.rejects(
      launchWebDappBrowser(await launchArgs(s), launchEnv(s, { mode: 'silent' }), fast),
    );
    trackPids(s.runtime);
    assert.equal(existsSync(path.join(s.runtime, 'browser.pid')), false);
    assert.equal(statSync(s.runtime).mode & 0o777, 0o700);
    assert.equal(processesMatching(`--user-data-dir=${s.runtime}/profile-`), '');
  });

  it('stops the browser and host when the wallet host never becomes ready', async () => {
    const s = await slot();
    await assert.rejects(
      launchWebDappBrowser(await launchArgs(s), launchEnv(s, { mode: 'http-only' }), fast),
      /wallet host (ready|exited before it was ready)/,
    );
    assert.equal(processesMatching(`--user-data-dir=${s.runtime}/profile-`), '');
    assert.equal(processesMatching(`--runtime-dir ${s.runtime}`), '');
  });

  it('removes the key fixture and vault state when the browser cannot be spawned (EACCES)', async () => {
    const s = await slot();
    const notExecutable = path.join(
      mkdtempSync(path.join(os.tmpdir(), 'terminal-eacces-')),
      'browser',
    );
    writeFileSync(notExecutable, '#!/bin/sh\nexit 0\n', { mode: 0o644 });
    const env = launchEnv(s, { browser: notExecutable });
    await assert.rejects(
      launchWebDappBrowser(
        await launchArgs(s, { signer: 'extension', 'signer-module': TEST_SIGNER }),
        env,
        fast,
      ),
      /could not start browser: EACCES/,
    );
    assert.equal(existsSync(path.join(s.runtime, 'wallet-fixture.dev1.json')), false);
    assert.equal(existsSync(path.join(s.runtime, 'fixture-state.dev1.json')), false);
    assert.equal(existsSync(path.join(s.runtime, 'browser.pid')), false);
  });

  it('removes the per-slot key fixture when extension seeding fails', async () => {
    const s = await slot();
    const env = launchEnv(s, { TEST_SIGNER_FAIL: 'after' });
    await assert.rejects(
      launchWebDappBrowser(
        await launchArgs(s, { signer: 'extension', 'signer-module': TEST_SIGNER }),
        env,
        fast,
      ),
      /afterBrowserStart failed/,
    );
    assert.equal(existsSync(path.join(s.runtime, 'wallet-fixture.dev1.json')), false);
    assert.equal(existsSync(path.join(s.runtime, 'fixture-state.dev1.json')), false);
    assert.equal(existsSync(path.join(s.runtime, 'browser.pid')), false);
    assert.equal(processesMatching(`--user-data-dir=${s.runtime}/profile-`), '');
  });

  it('removes the per-slot key fixture when the signer fails while preparing the profile', async () => {
    const s = await slot();
    const env = launchEnv(s, { TEST_SIGNER_FAIL: 'prepare' });
    await assert.rejects(
      launchWebDappBrowser(
        await launchArgs(s, { signer: 'extension', 'signer-module': TEST_SIGNER }),
        env,
        fast,
      ),
      /prepareProfile failed/,
    );
    assert.equal(existsSync(path.join(s.runtime, 'wallet-fixture.dev1.json')), false);
    assert.equal(existsSync(path.join(s.runtime, 'fixture-state.dev1.json')), false);
  });

  it('refuses signer=extension when no extension signer is configured', async () => {
    const s = await slot();
    const env = launchEnv(s);
    delete env.RECIPE_WEB_DAPP_SIGNER_MODULE;
    await assert.rejects(
      launchWebDappBrowser(await launchArgs(s, { signer: 'extension' }), env, fast),
      /signer=extension needs an extension signer/,
    );
  });

  it('rejects a prepareProfile that returns nothing, with a clear message', async () => {
    const s = await slot();
    const dir = mkdtempSync(path.join(os.tmpdir(), 'web-dapp-signer-'));
    const file = path.join(dir, 'signer.mjs');
    writeFileSync(
      file,
      'export const signers = { extension: { prepareProfile() {}, confirm() {} } };\n',
    );
    await assert.rejects(
      launchWebDappBrowser(
        await launchArgs(s, { signer: 'extension', 'signer-module': file }),
        launchEnv(s),
        fast,
      ),
      /prepareProfile must return \{ browserArgs, secrets, state \}/,
    );
  });

  it('requires confirm from an extension signer', async () => {
    const s = await slot();
    const dir = mkdtempSync(path.join(os.tmpdir(), 'web-dapp-signer-'));
    const file = path.join(dir, 'signer.mjs');
    writeFileSync(
      file,
      'export const signers = { extension: { prepareProfile() { return { browserArgs: [], secrets: [], state: {} }; } } };\n',
    );
    await assert.rejects(
      launchWebDappBrowser(
        await launchArgs(s, { signer: 'extension', 'signer-module': file }),
        launchEnv(s),
        fast,
      ),
      /extension signer must provide confirm/,
    );
  });

  it('lets afterBrowserStart register key material, removed when the launch ends', async () => {
    const s = await slot();
    const dir = mkdtempSync(path.join(os.tmpdir(), 'web-dapp-signer-'));
    const file = path.join(dir, 'signer.mjs');
    const late = path.join(dir, 'late-secret.json');
    writeFileSync(
      file,
      `import { writeFileSync } from 'node:fs';
export const signers = { extension: {
  prepareProfile() { return { browserArgs: [], secrets: [], state: {}, afterBrowserStart({ trackSecret }) {
    writeFileSync(trackSecret(${JSON.stringify(late)}), 'secret');
    return {};
  } }; },
  confirm() { return { isWalletSurfaceUrl: () => false, observe() {} }; },
} };
`,
    );
    const args = await launchArgs(s, { signer: 'extension', 'signer-module': file });
    await launchWebDappBrowser(args, launchEnv(s), {
      timeouts: { browserStartMs: 15000, hostReadyMs: 30000 },
    });
    trackPids(s.runtime);
    assert.equal(existsSync(late), false);
    await stopWebDappBrowser(s.root, { cdpPort: args['cdp-port'] });
  });

  it('records the signer state and gives the wallet host the signer arguments on a good launch', async () => {
    const s = await slot();
    const args = await launchArgs(s, { signer: 'extension', 'signer-module': TEST_SIGNER });
    const state = await launchWebDappBrowser(args, launchEnv(s), {
      timeouts: { browserStartMs: 15000, hostReadyMs: 30000 },
    });
    trackPids(s.runtime);
    assertMatch(state, {
      signer: 'extension',
      extension: { id: 'stubextension', version: '0.0.0', seeded: true },
    });
    assert.ok(processCommandOf(state.browserPid).includes('--test-signer-extension=stubextension'));
    assert.ok(processCommandOf(state.hostPid).includes('--extension-id stubextension'));
    assert.equal(existsSync(path.join(s.runtime, 'wallet-fixture.dev1.json')), false);
    await stopWebDappBrowser(s.root, { cdpPort: args['cdp-port'] });
  });
});
