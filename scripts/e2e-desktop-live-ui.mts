#!/usr/bin/env tsx
// Isolated desktop/Vite proof against an existing gateway. No inference or dispatch.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { openSync, closeSync } from 'node:fs';
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';

const root = process.cwd();
const evidence = path.resolve('temp/desktop-live-ui');
await mkdir(evidence, { recursive: true });
const profile = await mkdtemp(path.join(evidence, 'profile-'));
const port = '9513';
const inspector = '9514';
const vitePort = '5186';
const devUrl = `http://localhost:${vitePort}/`;
const gateway = process.env.FARMSLOT_GATEWAY ?? 'ws://127.0.0.1:7801/ws';
const token = process.env.FARMSLOT_GATEWAY_TOKEN;
assert(token, 'Set FARMSLOT_GATEWAY_TOKEN without printing it');
const app = path.resolve('apps/command-center-desktop/release-dev/mac-arm64/Farmslot Dev.app');
const env = { ...process.env, FARMSLOT_CDP_PORT: port };
function cdp(...args: string[]) {
  return execFileSync(process.execPath, ['apps/command-center/scripts/cdp.mjs', ...args], {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 30_000,
    stdio: 'pipe',
  }).trim();
}
function value(expression: string) {
  return JSON.parse(cdp('eval', '-', `return {value:await (${expression})};`)).value;
}
async function native(expression: string) {
  const [target] = await (await fetch(`http://127.0.0.1:${inspector}/json/list`)).json();
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await once(socket, 'open');
  try {
    const response = new Promise<any>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Native action timed out')), 10_000);
      socket.on('message', (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.id === 1) {
          clearTimeout(timeout);
          resolve(message);
        }
      });
    });
    socket.send(
      JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: {
          expression: `(()=>{const e=process.mainModule.require('electron');${expression}})()`,
          returnByValue: true,
          awaitPromise: true,
        },
      }),
    );
    const result = await response;
    assert(!result.result.exceptionDetails, 'Native action failed');
    return result.result.result.value;
  } finally {
    socket.close();
  }
}
async function waitFor(check: () => boolean | Promise<boolean>, label: string) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await delay(300);
  }
  throw new Error(`Timed out: ${label}`);
}
async function endpoint(url: string) {
  try {
    return (await fetch(url)).ok;
  } catch {
    return false;
  } // A stopped fixture has no HTTP endpoint.
}
for (const p of [port, inspector, vitePort]) {
  assert(!(await endpoint(`http://localhost:${p}/json/list`)), `Fixture port ${p} is occupied`);
}
let appProcess;
let vite;
function run(command: string, args: string[], extraEnv: Record<string, string>) {
  const log = openSync(path.join(evidence, 'process.log'), 'a');
  const child = spawn(command, args, {
    cwd: root,
    env: { ...process.env, ...extraEnv },
    stdio: ['ignore', log, log],
  });
  closeSync(log);
  return child;
}
async function startVite() {
  vite = run(
    path.join(root, 'node_modules/.bin/vite'),
    ['--config', 'apps/command-center/ui/vite.config.ts'],
    {
      VITE_PORT: vitePort,
      GATEWAY_PORT: new URL(gateway).port,
    },
  );
  await waitFor(() => endpoint(devUrl), 'Vite startup');
}
async function stopVite() {
  const stopped = once(vite, 'exit');
  vite.kill('SIGTERM');
  await stopped;
  vite = null;
}
async function launch(appPath = app, userData = profile) {
  appProcess = run(
    path.join(appPath, 'Contents/MacOS', path.basename(appPath, '.app')),
    [`--inspect=127.0.0.1:${inspector}`],
    {
      FARMSLOT_DESKTOP_USER_DATA: userData,
      FARMSLOT_DESKTOP_CDP_PORT: port,
    },
  );
  await waitFor(async () => {
    if (!(await endpoint(`http://127.0.0.1:${port}/json/list`))) return false;
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    return targets.some((t: any) => t.type === 'page' && t.url.startsWith('http'));
  }, 'desktop launch');
}
async function quit() {
  const stopped = once(appProcess, 'exit');
  await native('setTimeout(()=>e.app.quit(),100);return true;');
  await stopped;
  appProcess = null;
}
async function settings() {
  await native(
    `e.Menu.getApplicationMenu().items[0].submenu.items.find(i=>i.label.startsWith('Connection Settings')).click(); return true;`,
  );
  await waitFor(
    () =>
      value(
        'location.pathname === "/settings" && !document.querySelector("#development-form").hidden',
      ),
    'settings',
  );
}
async function connected() {
  await waitFor(
    () =>
      value(
        'document.querySelector("farm-app")?.connection === "connected" && document.querySelector("farm-app")?.hydrated === true',
      ),
    'gateway connection',
  );
}
const checks: string[] = [];
function record(check: string) {
  checks.push(check);
  console.log(`PASS ${check}`);
}
const index = path.join(root, 'apps/command-center/ui/index.html');
const original = await readFile(index, 'utf8');
try {
  await startVite();
  await launch();
  cdp('fill', '-', '#gateway-url', gateway);
  cdp('fill', '-', '#secret', token);
  // Select the actual test frontend before the first connection.
  cdp('fill', '-', '#development-url', devUrl);
  cdp('click', '-', '#development-form button[type=submit]');
  await delay(400);
  cdp('fill', '-', '#gateway-url', gateway);
  cdp('fill', '-', '#secret', token);
  cdp('click', '-', '#connection-form button');
  await connected();
  assert.equal(value('location.origin'), new URL(devUrl).origin);
  assert.equal(await native('return e.app.getName();'), 'Farmslot Dev');
  assert.equal(await native('return e.app.getPath("userData");'), profile);
  const fleet = JSON.parse(cdp('gateway', 'fleet.status', '{}'));
  assert(fleet, 'Real gateway read must succeed');
  record('Dev profile connects through live UI and real gateway');
  cdp('eval', '-', 'location.hash="#runs"; return true;');
  await writeFile(index, original.replace('Farmslot Command Center', 'Farmslot live reload proof'));
  await waitFor(() => value('document.title === "Farmslot live reload proof"'), 'source reload');
  await connected();
  assert.equal(value('location.hash'), '#runs');
  record('Source edit reloads automatically and retains login and route');
  await writeFile(index, original);
  await waitFor(() => value('document.title === "Farmslot Command Center"'), 'restore reload');
  await connected();
  await settings();
  cdp('fill', '-', '#development-url', 'https://example.com/');
  cdp('click', '-', '#development-form button[type=submit]');
  await waitFor(
    () => value('document.querySelector("#development-status").textContent.includes("loopback")'),
    'remote URL rejection',
  );
  cdp('fill', '-', '#development-url', devUrl);
  cdp('click', '-', '#development-form button[type=submit]');
  await connected();
  const denied = await native(
    `return e.BrowserWindow.getAllWindows()[0].webContents.executeJavaScript("window.farmslotDesktop.saveDevelopment({enabled:false}).then(()=>false,()=>true)");`,
  );
  assert(denied, 'UI cannot replace its trusted source outside settings');
  record('Remote UI URL and source changes outside settings are rejected');
  execFileSync('open', ['-a', app, 'farmslot-dev://decisions']);
  await waitFor(() => value('location.hash === "#decisions"'), 'Dev OS deep link');
  await native(
    `e.Menu.getApplicationMenu().getMenuItemById('copy-desktop-link').click(); return true;`,
  );
  await waitFor(
    async () => (await native('return e.clipboard.readText();')) === 'farmslot-dev://decisions',
    'copy Dev link',
  );
  const count = value('document.querySelector("farm-app").decisionCount');
  assert.equal(await native('return e.app.dock.getBadge();'), count ? String(count) : '');
  cdp('screenshot', '-', path.join(evidence, 'live.png'));
  record('Dev scheme, native copy link and pending-decision badge work');
  await quit();
  await launch();
  await connected();
  assert.equal(value('location.hash'), '#decisions');
  assert.equal(value('location.origin'), new URL(devUrl).origin);
  record('Quit and relaunch retain encrypted login and live UI preference');
  await stopVite();
  cdp('eval', '-', 'location.reload(); return true;');
  await waitFor(
    () =>
      value(
        'location.pathname === "/settings" && !document.querySelector("#development-recovery").hidden',
      ),
    'server unavailable recovery',
  );
  cdp('screenshot', '-', path.join(evidence, 'recovery.png'));
  cdp('click', '-', '#development-bundled');
  await connected();
  assert.equal(value('location.pathname'), '/cc/');
  record('Stopped Vite recovers to settings and bundled UI reconnects');
  await startVite();
  await settings();
  cdp('click', '-', '#development-retry');
  await connected();
  assert.equal(value('location.origin'), new URL(devUrl).origin);
  assert.equal(value('location.hash'), '#decisions');
  record('Retry returns to live UI and retains route');
  await quit();
  const production = path.resolve('apps/command-center-desktop/release/mac-arm64/Farmslot.app');
  const productionProfile = await mkdtemp(path.join(evidence, 'production-'));
  await launch(production, productionProfile);
  assert.equal(value('document.querySelector("#development-form").hidden'), true);
  assert.equal(await native('return e.app.getName();'), 'Farmslot');
  assert.equal(await native('return e.app.getPath("userData");'), productionProfile);
  assert.equal(value('document.querySelector("#secret").value.length'), 0);
  cdp('fill', '-', '#gateway-url', gateway);
  cdp('fill', '-', '#secret', token);
  cdp('click', '-', '#connection-form button');
  await connected();
  assert.equal(value('location.pathname'), '/cc/');
  assert.equal(
    value(
      'window.farmslotDesktop.saveDevelopment({enabled:true,url:"http://localhost:5186/"}).then(()=>false,()=>true)',
    ),
    true,
  );
  record('Production keeps its own login and bundled UI and rejects Development UI');
  await writeFile(path.join(evidence, 'result.json'), JSON.stringify({ checks }, null, 2));
} catch (error) {
  console.error(String(error).replaceAll(token, '[redacted]'));
  process.exitCode = 1;
} finally {
  if ((await readFile(index, 'utf8')) !== original) await writeFile(index, original);
  if (appProcess && appProcess.exitCode === null) await quit();
  if (vite && vite.exitCode === null) await stopVite();
}
