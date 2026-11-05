#!/usr/bin/env node
// Project-owned Next.js server lifecycle; browser ownership stays in adapter-web.
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const script = fileURLToPath(import.meta.url);
const [operation, suppliedRoot, appPort, browserPort] = process.argv.slice(2);
assert(suppliedRoot, 'Expected command, checkout, application port and browser port.');
const root = fs.realpathSync(suppliedRoot);
const ports = [Number(appPort), Number(browserPort)];
assert(
  ports.every((value) => Number.isInteger(value) && value > 1024 && value < 65536) &&
    ports[0] !== ports[1],
  'Use two distinct assigned slot ports.',
);
const tools = path.join(root, '.agent/recipe-provider');
const stateFile = path.join(root, '.agent/siteed-server.json');
const logFile = path.join(root, '.agent/siteed-server.log');
const url = `http://127.0.0.1:${ports[0]}/`;
const configuration = JSON.parse(
  fs.readFileSync(path.join(root, '.agent/recipe-provider/web-project.json'), 'utf8'),
);
assert(
  Array.isArray(configuration.command) &&
    configuration.command.length &&
    configuration.command.every((arg) => typeof arg === 'string'),
  'Declare the project server command as an argv array.',
);
assert(
  Array.isArray(configuration.install) &&
    configuration.install.every((arg) => typeof arg === 'string'),
  'Declare the project install command as an argv array, or an empty array.',
);
process.env.RECIPE_WATCHER_PORT = String(ports[0]);
process.env.RECIPE_CDP_PORT = String(ports[1]);

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited ${result.status ?? result.signal}`);
}
function requireTools() {
  return createRequire(path.join(tools, 'package.json'));
}
async function browserRuntime() {
  const file = requireTools().resolve('@farmslot/adapter-web/plain-web');
  return import(pathToFileURL(file).href);
}
function server(expectExit = false) {
  if (!fs.existsSync(stateFile)) return undefined;
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  if (!Number.isInteger(state.pid) || state.port !== ports[0])
    throw new Error('Sandbox metadata does not match this slot.');
  const inspect = spawnSync(
    'ps',
    ['-ww', '-p', String(state.pid), '-o', 'stat=,lstart=,command='],
    {
      encoding: 'utf8',
    },
  );
  if (inspect.status === 1 && !inspect.stdout.trim()) return undefined;
  if (inspect.error || inspect.status !== 0)
    throw inspect.error ?? new Error('Cannot inspect the sandbox owner.');
  const row = inspect.stdout.trim();
  const processState = row.split(/\s+/u)[0];
  // A terminated child can remain a zombie until reaped; it is no live owner.
  if (processState.startsWith('Z')) return undefined;
  const identity = row.slice(processState.length).trim();
  if (identity !== state.identity && expectExit) return undefined;
  if (identity !== state.identity)
    throw new Error('Sandbox pid ownership changed; refusing to signal it.');
  return state;
}
async function healthy() {
  assert(server(), 'The prepared sandbox server is not running.');
  const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
  await response.body?.cancel();
  assert(response.ok, `Sandbox returned HTTP ${response.status}.`);
}
async function start() {
  if (server()) {
    await healthy();
    return;
  }
  // A listener without our owner record is never reused or killed.
  const listener = spawnSync('lsof', ['-nP', `-iTCP:${ports[0]}`, '-sTCP:LISTEN', '-t'], {
    encoding: 'utf8',
  });
  if (listener.error || ![0, 1].includes(listener.status))
    throw listener.error ?? new Error('Cannot inspect the application port.');
  assert(!listener.stdout.trim(), 'The assigned application port has an unowned listener.');
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const fd = fs.openSync(logFile, 'a');
  const child = spawn(process.execPath, [script, 'serve', root, ...ports.map(String)], {
    cwd: root,
    detached: true,
    stdio: ['ignore', fd, fd],
  });
  fs.closeSync(fd);
  assert(child.pid, 'Sandbox did not start.');
  child.unref();
  try {
    const identity = execFileSync(
      'ps',
      ['-ww', '-p', String(child.pid), '-o', 'lstart=,command='],
      { encoding: 'utf8' },
    ).trim();
    fs.writeFileSync(stateFile, JSON.stringify({ pid: child.pid, port: ports[0], identity }), {
      mode: 0o600,
    });
    const deadline = Date.now() + 90_000;
    let lastError;
    do {
      try {
        await healthy();
        return;
      } catch (error) {
        lastError = error;
      }
      if (!server()) throw new Error('Sandbox exited during startup; inspect its log.');
      await delay(150);
    } while (Date.now() < deadline);
    throw lastError;
  } catch (error) {
    if (server()) process.kill(-child.pid, 'SIGTERM');
    throw error;
  }
}
async function stop() {
  const state = server();
  if (state) {
    process.kill(-state.pid, 'SIGTERM');
    const deadline = Date.now() + 5000;
    // After our signal, an identity change means this owner exited or its pid was reused.
    while (server(true) && Date.now() < deadline) await delay(50);
    if (server(true)) throw new Error('Sandbox did not stop; its owner record is retained.');
  }
  const listener = spawnSync('lsof', ['-nP', `-iTCP:${ports[0]}`, '-sTCP:LISTEN', '-t'], {
    encoding: 'utf8',
  });
  if (listener.error || ![0, 1].includes(listener.status))
    throw listener.error ?? new Error('Cannot inspect the sandbox port after stop.');
  assert(
    !listener.stdout.trim(),
    'Sandbox port still has a listener; its owner record is retained.',
  );
  fs.rmSync(stateFile, { force: true });
}

if (operation === 'serve') {
  const command = configuration.command.map((arg) =>
    arg.replaceAll('{{port}}', String(ports[0])).replaceAll('{{repo}}', root),
  );
  const child = spawn(command[0], command.slice(1), { cwd: root, stdio: 'inherit' });
  const [code, signal] = await once(child, 'exit');
  process.exitCode = signal ? 1 : code;
} else if (operation === 'prepare') {
  assert(Number(process.versions.node.split('.')[0]) >= 22, 'Node 22 or later is required.');
  if (configuration.install.length) run(configuration.install[0], configuration.install.slice(1));
  const candidate = process.env.SITEED_WEB_ADAPTER_TARBALL;
  if (candidate)
    assert(
      path.isAbsolute(candidate) && fs.existsSync(candidate) && candidate.endsWith('.tgz'),
      'Candidate adapter must be an existing absolute tarball.',
    );
  run(
    'npm',
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--package-lock=false',
      ...(candidate ? ['--no-save', candidate] : []),
    ],
    tools,
  );
  await browserRuntime(); // Fail prepare if an older package lacks the required runtime.
  run('capture-helper', ['version', '--json']);
} else if (operation === 'start') {
  await start();
  console.log(`Sandbox URL: ${url}\nready`);
} else if (operation === 'health') {
  await healthy();
  console.log(`Sandbox URL: ${url}\nready`);
} else if (operation === 'browser-stop') {
  (await browserRuntime()).stopPlainWebBrowser(root);
} else if (operation === 'browser' || operation === 'browser-health') {
  await healthy();
  const { createProvider } = await import(
    pathToFileURL(path.join(root, '.agent/recipe-provider/provider.mjs')).href
  );
  const { runtime } = createProvider();
  if (operation === 'browser') await runtime.launch({ target: root });
  const status = await runtime.runtimeStatus(root);
  assert.equal(status.decision, 'ready', status.reasons.join('; '));
  console.log('ready');
} else if (operation === 'stop') {
  (await browserRuntime()).stopPlainWebBrowser(root);
  await stop();
} else throw new Error(`Unknown siteed-web lifecycle operation: ${operation}`);
