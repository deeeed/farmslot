// Manual macOS proof only. Every tmux command selects a private fixture socket.
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
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
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { shSingleQuote as q } from '../../../../scripts/lib/shell-quote.mjs';

import { withBlindTrialBoundary } from './blind-git.js';

const python = fileURLToPath(new URL('./blind-git.py', import.meta.url));
const adapter = fileURLToPath(new URL('../../../../packages/adapter-web/', import.meta.url));
const { stopWebDappBrowser } = await import(path.join(adapter, 'src/web-dapp/lib/processes.mjs'));
const env = {
  PATH: process.env.PATH,
  HOME: os.homedir(),
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
function worker(root: string, command: string, launchEnv = env, timeout = 45_000) {
  return spawnSync(
    '/bin/sh',
    [
      '-c',
      withBlindTrialBoundary(command, root).replace(
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
              root,
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
    writeFileSync(root + '/pi-ready-' + mode + '.json', JSON.stringify({ probePid: process.pid, piPid: child.pid }));
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
  writeFileSync(agent + '/models.json', JSON.stringify({ providers: { 'seatbelt-fixture': {
    baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1', api: 'openai-completions', apiKey: 'fixture-only',
    models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 128 }],
  } } }));
  child = spawn(${JSON.stringify(pi)}, ['--offline', '--print', '--no-session', '--no-tools', '--no-extensions', '--no-mcp', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-themes', '--provider', 'seatbelt-fixture', '--model', 'fixture', '--system-prompt', 'Synthetic fixture only.', 'Reply with seatbelt-fixture-ok'], { cwd: root, env: { ...process.env, PI_CODING_AGENT_DIR: agent }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const [code, signal] = await once(child, 'close');
  if (mode !== 'normal') {
    assert.ok(signal, 'interrupted Pi should be terminated');
  } else {
    assert.equal(code, 0, stderr);
    assert.match(stdout, /seatbelt-fixture-ok/u);
    console.log('pi completed a turn through a local synthetic provider');
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
    for (const mode of ['timeout', 'SIGTERM', 'SIGINT', 'parent-death'] as const) {
      await t.test(`interrupted pi fixture cleans up on ${mode}`, async (childTest) => {
        const ready = path.join(root, `pi-ready-${mode}.json`);
        // A failed regression must still reap the owned fixture child.
        childTest.after(() => {
          if (!existsSync(ready)) return;
          const { piPid } = JSON.parse(readFileSync(ready, 'utf8'));
          try {
            process.kill(piPid, 'SIGKILL');
          } catch (error) {
            if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
          }
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
                root,
              ).replace('/usr/bin/sandbox-exec', 'exec /usr/bin/sandbox-exec'),
            ],
            { env, stdio: ['ignore', 'pipe', 'pipe'] },
          );
          const exited = once(child, 'exit');
          let stderr = '';
          child.stderr.on('data', (chunk) => {
            stderr += chunk;
          });
          childTest.after(async () => {
            child.kill('SIGKILL');
            await exited;
          });
          const deadline = Date.now() + 10000;
          while (
            !existsSync(ready) &&
            child.exitCode === null &&
            child.signalCode === null &&
            Date.now() < deadline
          )
            await delay(25);
          assert.ok(existsSync(ready), stderr);
          if (mode === 'parent-death') {
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
        assert.ok(existsSync(ready), 'Pi must reach the synthetic provider before interruption');
        const { piPid } = JSON.parse(readFileSync(ready, 'utf8'));
        assert.throws(() => process.kill(piPid, 0), { code: 'ESRCH' });
      });
    }
    t.diagnostic(
      'pi local-provider turn and version/help, Git repository/hash operations, Node DNS/child spawning passed with only mDNSResponder allowed; syslog needs no exception; Chrome/CDP covered separately',
    );
  },
);
