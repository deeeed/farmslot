// web-dapp parity with the Extension adapter, lifecycle side: the log sources
// the run diagnostics read, the wallet request findings, and the slot browser
// never taking macOS focus (LaunchServices background launch for a visible
// browser, one restore after a launch, observe-only in the wallet host).
// Ported from mm-harness's web-dapp-diagnostics-focus tests; the console
// capture and classification, the collector ownership and the page actions
// (withAppPage, assert_no_console_errors) stay with the host and the actions.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  checkFocusAfterLaunch,
  createWebDappAdapter,
  launchMethodFor,
  macApplicationForExecutable,
  ownerMarker,
  walletRequestFindings,
} from '../src/web-dapp/index.mjs';

const require = createRequire(import.meta.url);
const { assertMatch } = require('./fixtures/match.cjs');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STUB_BROWSER = path.join(HERE, 'fixtures/web-dapp-stub-browser.mjs');
const TEST_SIGNER = path.join(HERE, 'fixtures/web-dapp-test-signer.mjs');
const WALLET_HOST = path.join(HERE, '../src/web-dapp/wallet-host.mjs');
// The venue policy web-dapp's members and leaves read, as an adapter that extends it binds it.
process.env.RECIPE_WEB_DAPP_POLICY = path.join(HERE, 'fixtures/web-dapp-policy.mjs');
const LAUNCH_SERVICES = 'launch-services';
const SPAWN = 'spawn';
const started = [];

after(() => {
  for (const pid of started) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* gone */
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

function pgrepCount(pattern) {
  return spawnSync('pgrep', ['-f', '--', pattern], { encoding: 'utf8' })
    .stdout.trim()
    .split('\n')
    .filter(Boolean).length;
}

async function waitFor(check, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !check())
    await new Promise((resolve) => setTimeout(resolve, 100));
  return check();
}

describe('web-dapp application diagnostics', () => {
  it('reads the terminal page console and keeps the other logs as sources', () => {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'terminal-logs-')));
    const runtime = path.join(root, 'temp/recipe/runtime/terminal');
    const adapter = createWebDappAdapter({ hooks: {} });
    assert.deepEqual(adapter.appLogSource(root), {
      label: 'app-console',
      path: path.join(runtime, 'app-console.log'),
    });
    const labels = adapter.logSources(root).map((source) => source.label);
    for (const label of [
      'app-console',
      'extension-console',
      'wallet-requests',
      'wallet-host',
      'browser',
      'next',
    ]) {
      assert.ok(labels.includes(label), label);
    }
  });

  it('leaves the extension console out of the sources of an injected-signer browser', () => {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'terminal-logs-injected-')));
    const runtime = path.join(root, 'temp/recipe/runtime/terminal');
    mkdirSync(runtime, { recursive: true });
    writeFileSync(path.join(runtime, 'browser.json'), JSON.stringify({ signer: 'injected' }));
    const labels = createWebDappAdapter({ hooks: {} })
      .logSources(root)
      .map((source) => source.label);
    assert.equal(labels.includes('extension-console'), false);
    assert.ok(labels.includes('app-console'));
  });

  it('surfaces non-probe mainnet blocks, refusals and unattributed calls from the run in diagnostics', () => {
    const lines = [
      {
        kind: 'blocked-mainnet',
        transport: 'http',
        url: 'https://api.hyperliquid.xyz/info',
        probe: true,
      },
      {
        kind: 'blocked-mainnet',
        transport: 'websocket',
        url: 'wss://api.hyperliquid.xyz/ws',
        probe: false,
      },
      {
        kind: 'refused-mainnet',
        method: 'eth_signTypedData_v4',
        reason: 'hyperliquidChain=Mainnet',
      },
      { kind: 'unattributed', binding: 'request', method: 'eth_sendTransaction' },
      { kind: 'request', method: 'eth_requestAccounts' },
    ].map((entry) => JSON.stringify(entry));
    const findings = walletRequestFindings(lines);
    assert.deepEqual(
      findings.map((finding) => [finding.source, finding.level, finding.text]),
      [
        ['wallet', 'error', 'blocked-mainnet: websocket to wss://api.hyperliquid.xyz/ws'],
        ['wallet', 'error', 'refused-mainnet: eth_signTypedData_v4 (hyperliquidChain=Mainnet)'],
        ['wallet', 'error', 'unattributed wallet request (eth_sendTransaction)'],
      ],
    );
    // The adapter reads the same log through its request-log hook.
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'wallet-findings-')));
    const adapter = createWebDappAdapter({ hooks: {} });
    assert.equal(
      adapter.diagnostics.requestLog.path(root),
      path.join(root, 'temp/recipe/runtime/terminal/wallet-requests.jsonl'),
    );
    assert.deepEqual(adapter.diagnostics.requestLog.findings(lines), findings);
  });
});

describe('web-dapp focus', () => {
  // lsappinfo, osascript and open stubbed in PATH: lsappinfo reports `frontPid`
  // as the front app; any activation attempt is logged to `calls`.
  function focusStubs(root, frontPid) {
    const bin = path.join(root, 'bin');
    const calls = path.join(root, 'activation-calls.log');
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      path.join(bin, 'lsappinfo'),
      `#!/bin/sh\ncase "$1" in\n  front) echo "ASN:0x0-0x1" ;;\n  info) printf '"Front App" ASN:0x0-0x1: (in front)\\n    pid = ${frontPid} type="Foreground"\\n' ;;\nesac\n`,
      { mode: 0o755 },
    );
    writeFileSync(
      path.join(bin, 'osascript'),
      `#!/bin/sh\necho "osascript $*" >> "${calls}"\necho ok\n`,
      { mode: 0o755 },
    );
    writeFileSync(path.join(bin, 'open'), `#!/bin/sh\necho "open $*" >> "${calls}"\n`, {
      mode: 0o755,
    });
    return {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FARMSLOT_FOCUS_HOLD: '1' },
      calls: () => (existsSync(calls) ? readFileSync(calls, 'utf8') : ''),
    };
  }

  // The launcher's one focus check (macos-focus), in process and without
  // waiting on anything: our browser pid is given, lsappinfo and osascript are
  // PATH stubs, and each case gets a fresh focus module (it restores at most
  // once per instance).
  it(
    'after a launch, restores the captured app once, by pid, only if our browser is in front',
    { skip: process.platform !== 'darwin' },
    () => {
      const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'terminal-focus-restore-')));
      const runtime = path.join(root, 'runtime');
      mkdirSync(runtime, { recursive: true });
      const focusModule = require.resolve('../src/macos-focus.cjs');
      const freshFocus = () => {
        delete require.cache[focusModule];
        return require(focusModule);
      };
      const previous = { pid: 777, name: 'Operator App' };
      const ours = 4242;
      const check = (stubs, { times = 1, env = {} } = {}) => {
        const focus = freshFocus();
        const saved = {
          PATH: process.env.PATH,
          FARMSLOT_FOCUS_HOLD: process.env.FARMSLOT_FOCUS_HOLD,
        };
        Object.assign(process.env, { PATH: stubs.env.PATH, FARMSLOT_FOCUS_HOLD: '1', ...env });
        try {
          return Array.from({ length: times }, () =>
            checkFocusAfterLaunch(runtime, previous, { ourPids: [ours], focus }),
          );
        } finally {
          Object.assign(process.env, saved);
        }
      };
      const inFront = focusStubs(path.join(root, 'ours'), ours);
      // Asked twice in one launcher: one restore.
      assert.deepEqual(check(inFront, { times: 2 }), ['restored', 'off']);
      assert.match(
        inFront.calls(),
        /^osascript -l JavaScript -e [\s\S]*NSRunningApplication[\s\S]* 777\n$/u,
      );
      // The operator switched to another app (e.g. their own Chrome, same bundle as ours): left alone.
      const switched = focusStubs(path.join(root, 'switched'), 9999);
      assert.deepEqual(check(switched), ['kept']);
      assert.equal(switched.calls(), '');
      // Turned off.
      const off = focusStubs(path.join(root, 'off'), ours);
      assert.deepEqual(check(off, { env: { FARMSLOT_FOCUS_HOLD: '0' } }), ['off']);
      assert.equal(off.calls(), '');
      assert.match(
        readFileSync(path.join(runtime, 'focus.log'), 'utf8'),
        /restored Operator App \(pid 777\) once[\s\S]*left alone/u,
      );
    },
  );

  it(
    'the wallet host only observes focus, by our browser pids, after a wallet window opens; it never activates an app',
    { skip: process.platform !== 'darwin' },
    async () => {
      const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'terminal-focus-observe-')));
      const runtime = path.join(root, 'runtime');
      mkdirSync(runtime, { recursive: true });
      // A process that proves it is this slot's browser (owner marker).
      const ours = spawn(
        process.execPath,
        ['-e', 'setInterval(() => {}, 1000)', '--', ownerMarker('browser', runtime)],
        { stdio: 'ignore' },
      );
      started.push(ours.pid);
      await waitFor(() => pgrepCount(ownerMarker('browser', runtime)) > 0, 5000);
      const stubs = focusStubs(root, ours.pid);
      const cdpPort = await freePort();
      const appOrigin = 'http://localhost:9342';
      const env = { ...stubs.env, STUB_MODE: 'notification', STUB_APP_ORIGIN: appOrigin };
      const browser = spawn(
        process.execPath,
        [STUB_BROWSER, `--remote-debugging-port=${cdpPort}`],
        { stdio: 'ignore', env },
      );
      started.push(browser.pid);
      await waitFor(() => false, 500);
      const host = spawn(
        process.execPath,
        [
          WALLET_HOST,
          '--cdp-port',
          String(cdpPort),
          '--runtime-dir',
          runtime,
          '--signer',
          'extension',
          '--app-origin',
          appOrigin,
          '--network',
          'testnet',
          '--mainnet-hosts',
          'api.hyperliquid.xyz',
          '--testnet-hosts',
          'api.hyperliquid-testnet.xyz',
          '--extension-id',
          'a'.repeat(32),
          '--signer-module',
          TEST_SIGNER,
          '--observe-focus',
          '1',
        ],
        { stdio: 'ignore', env },
      );
      started.push(host.pid);
      const focusLog = path.join(runtime, 'focus.log');
      assert.equal(
        await waitFor(
          () =>
            existsSync(focusLog) &&
            readFileSync(focusLog, 'utf8').includes(`(pid ${ours.pid}) is frontmost`),
          30000,
        ),
        true,
      );
      assert.match(
        readFileSync(focusLog, 'utf8'),
        /after a Test wallet notification window opened \(observed only\)/u,
      );
      assert.equal(stubs.calls(), '');
      // The signer's confirm hook also logged the confirmation it saw.
      const entries = readFileSync(path.join(runtime, 'wallet-requests.jsonl'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      assertMatch(
        entries.find((entry) => entry.kind === 'confirmation-shown'),
        {
          signer: 'extension',
          surface: 'notification',
          route: '/confirm-transaction/1/signature-request',
        },
      );
    },
  );

  it('starts an .app browser on macOS through LaunchServices, everything else directly', () => {
    const cft =
      '/cache/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
    assert.equal(
      macApplicationForExecutable(cft),
      '/cache/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app',
    );
    assert.equal(launchMethodFor(cft, { platform: 'darwin' }), LAUNCH_SERVICES);
    assert.equal(launchMethodFor(cft, { platform: 'linux' }), SPAWN);
    assert.equal(launchMethodFor(STUB_BROWSER, { platform: 'darwin' }), SPAWN);
  });
});
