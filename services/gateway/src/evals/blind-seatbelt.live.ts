// Manual macOS proof only. Every tmux command selects a private fixture socket.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
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
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { shSingleQuote as q } from '../../../../scripts/lib/shell-quote.mjs';

import { withBlindTrialBoundary } from './blind-git.js';

const python = fileURLToPath(new URL('./blind-git.py', import.meta.url));
const adapter = fileURLToPath(new URL('../../../../packages/adapter-web/', import.meta.url));
const env = {
  PATH: process.env.PATH,
  HOME: os.homedir(),
  TMPDIR: os.tmpdir(),
  PYTHONDONTWRITEBYTECODE: '1',
};

function fixture() {
  const root = realpathSync(mkdtempSync(path.join('/tmp', 'blind-seatbelt-live-')));
  mkdirSync(path.join(root, 'boundary'));
  writeFileSync(path.join(root, 'state.json'), '{"originalIsDirectory":true}');
  return root;
}
function profile(root: string, launchEnv = env) {
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
function worker(root: string, command: string, launchEnv = env) {
  return spawnSync('/bin/sh', ['-c', withBlindTrialBoundary(command, root)], {
    env: launchEnv,
    encoding: 'utf8',
    timeout: 45_000,
  });
}

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
    const alias = path.join(root, 'alias.sock');
    symlinkSync(sockets[1], alias);
    const hardAlias = path.join(root, 'hard.sock');
    linkSync(sockets[1], hardAlias);
    const marker = path.join(root, 'escaped');
    for (const prefix of [
      `TMUX_TMPDIR=${q(root)} tmux`,
      ...[
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
    // Prove teardown still reaches the second server when the first is gone.
    tmux(sockets[0], 'kill-server');
    const cleanup = stopServers();
    assert.notEqual(cleanup[0].status, 0);
    assert.equal(cleanup[1].status, 0, cleanup[1].stderr);
    t.diagnostic('cleanup attempted both private servers after the first was already absent');
  },
);

test(
  'same-UID ownership and headless Chrome CDP work under the retained outer seatbelt',
  { skip: process.platform !== 'darwin' },
  (t) => {
    const root = fixture();
    t.after(() => rmSync(root, { recursive: true }));
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
app.listen(0, '127.0.0.1');
await once(app, 'listening');
const portProbe = net.createServer();
portProbe.listen(0, '127.0.0.1');
await once(portProbe, 'listening');
const cdpPort = portProbe.address().port;
await new Promise(resolve => portProbe.close(resolve));
const runtime = root + '/temp/recipe/runtime/terminal';
const stop = () => stopWebDappBrowser(root, { runtimeDir: runtime });
process.on('SIGTERM', () => { void stop(); });
process.on('SIGINT', () => { void stop(); });
const watchdog = setInterval(() => {
  try { process.kill(${process.pid}, 0); }
  catch (error) { if (error.code !== 'ESRCH') throw error; void stop(); }
}, 100);
try {
  const args = { target: root, 'cdp-port': cdpPort, 'app-port': app.address().port, signer: 'injected', account: 'dev1', headless: true, 'fresh-profile': true };
  const state = await launchWebDappBrowser(args, process.env, { timeouts: { browserStartMs: 10000, hostReadyMs: 15000 } });
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
  const reused = await launchWebDappBrowser({ ...args, 'fresh-profile': false });
  assert.equal(reused.reused, true);
  assert.equal(reused.browserPid, state.browserPid);
  const stopped = await stop();
  assert.equal(stopped.stopped.length, 2);
  console.log('ps denied; ownership/group/state/start identity passed; harness launched and reused Chrome; Chrome CDP served; outer read denial retained');
} finally {
  clearInterval(watchdog);
  try { await stop(); }
  finally { await new Promise(resolve => app.close(resolve)); }
}
`,
    );
    const result = worker(root, `exec ${q(process.execPath)} ${q(probe)}`);
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Chrome CDP served; outer read denial retained/u);
    t.diagnostic(result.stdout.trim());
  },
);
