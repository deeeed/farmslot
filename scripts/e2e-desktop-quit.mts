#!/usr/bin/env tsx
// Native quit confirmation and lifecycle proof. Uses a disposable profile and
// real macOS keyboard/dialog actions, with only read-only gateway traffic.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';

import { confirmDesktopQuit } from './lib/desktop-quit.mjs';

const root = process.cwd();
const evidence = path.resolve(
  process.env.FARMSLOT_DESKTOP_APP ? 'temp/desktop-quit-production' : 'temp/desktop-quit',
);
await mkdir(evidence, { recursive: true });
const profile = await mkdtemp(path.join(evidence, 'profile-'));
const port = '9543';
const inspector = '9544';
const token = process.env.FARMSLOT_GATEWAY_TOKEN;
assert(token, 'Set FARMSLOT_GATEWAY_TOKEN without printing it');
const gateway = process.env.FARMSLOT_GATEWAY ?? 'ws://127.0.0.1:7801/ws';
const app = path.resolve(
  process.env.FARMSLOT_DESKTOP_APP ??
    'apps/command-center-desktop/release-dev/mac-arm64/Farmslot Dev.app',
);
const env = { ...process.env, FARMSLOT_CDP_PORT: port };
function cdp(...args: string[]) {
  return execFileSync(process.execPath, ['apps/command-center/scripts/cdp.mjs', ...args], {
    cwd: root,
    env,
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: 30000,
  }).trim();
}
function value(expression: string) {
  return JSON.parse(cdp('eval', '-', `return {value:await (${expression})};`)).value;
}
function osa(source: string) {
  return execFileSync('osascript', ['-e', source], {
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: 10000,
  }).trim();
}
let pid = 0;
function keyboard(key: string, command = false) {
  osa(`tell application "System Events"
set frontmost of (first process whose unix id is ${pid}) to true
${key === 'escape' ? 'key code 53' : `keystroke "${key}"${command ? ' using command down' : ''}`}
end tell`);
}
function sheetButtons() {
  return osa(`tell application "System Events" to tell (first process whose unix id is ${pid})
if not (exists window 1) then return ""
if not (exists sheet 1 of window 1) then return ""
return name of every button of sheet 1 of window 1
end tell`);
}

async function available(p: string) {
  try {
    return (await fetch(`http://127.0.0.1:${p}/json/list`)).ok;
  } catch {
    return false;
  } // The endpoint is absent before launch and after a complete quit.
}
async function wait(check: () => boolean | Promise<boolean>, name: string) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(200);
  }
  throw new Error(`Timed out: ${name}`);
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
async function launch() {
  execFileSync('open', [
    '--env',
    `FARMSLOT_DESKTOP_USER_DATA=${profile}`,
    '--env',
    `FARMSLOT_DESKTOP_CDP_PORT=${port}`,
    '-a',
    app,
    '--args',
    `--inspect=127.0.0.1:${inspector}`,
  ]);
  await wait(() => available(inspector), 'main process');
  pid = await native('return process.pid;');
  await wait(async () => {
    if (!(await available(port))) return false;
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    return targets.some((target: { url: string }) => target.url.startsWith('http'));
  }, 'renderer');
}
async function connected() {
  await wait(
    () =>
      value(
        'document.querySelector("farm-app")?.connection === "connected" && document.querySelector("farm-app")?.hydrated === true',
      ),
    'gateway connection',
  );
}
const checks: string[] = [];
function record(message: string) {
  checks.push(message);
  console.log(`PASS ${message}`);
}
try {
  assert(!(await available(port)) && !(await available(inspector)), 'Fixture ports must be free');
  assert.equal(
    osa('tell application "System Events" to get UI elements enabled'),
    'true',
    'Native UI automation needs Accessibility permission',
  );
  await writeFile(
    path.join(profile, 'preferences.json'),
    JSON.stringify({
      shortcut: '',
      route: '#runs',
      development: { enabled: true, url: 'http://localhost:5175/' },
    }),
  );
  await launch();
  await wait(
    () =>
      value(
        'Boolean(document.querySelector("#gateway-url") && !document.querySelector("#connection-form button").disabled)',
      ),
    'settings',
  );
  cdp('fill', '-', '#gateway-url', gateway);
  cdp('fill', '-', '#secret', token);
  cdp('click', '-', '#connection-form button');
  await connected();
  cdp(
    'eval',
    '-',
    'document.querySelector("whats-new-modal")?.shadowRoot?.querySelector("button.primary")?.click(); return true;',
  );
  const firstPid = pid;
  keyboard('q', true);
  await wait(
    () => sheetButtons().includes('Cancel') && sheetButtons().includes('Quit'),
    'quit confirmation',
  );
  keyboard('q', true);
  assert.equal(
    osa(
      `tell application "System Events" to tell (first process whose unix id is ${pid}) to get count of sheets of window 1`,
    ),
    '1',
  );
  const bounds = await native('return e.BrowserWindow.getAllWindows()[0].getBounds();');
  execFileSync('screencapture', [
    '-x',
    '-R',
    `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`,
    path.join(evidence, 'confirmation.png'),
  ]);
  keyboard('escape');
  await wait(() => sheetButtons() === '', 'cancel');
  await connected();
  assert.equal(await native('return process.pid;'), firstPid);
  record('Real Command+Q asks once; Escape cancels and keeps the connected window');
  await native('e.BrowserWindow.getAllWindows()[0].close(); return true;');
  assert.equal(await native('return e.BrowserWindow.getAllWindows()[0].isVisible();'), false);
  await launch();
  assert.equal(pid, firstPid);
  assert.equal(await native('return e.BrowserWindow.getAllWindows()[0].isVisible();'), true);
  record('Window close still hides the app and a normal macOS activation reopens it');
  keyboard('q', true);
  await wait(() => sheetButtons().includes('Quit'), 'second confirmation');
  confirmDesktopQuit(pid);
  await wait(
    async () => !(await available(port)) && !(await available(inspector)),
    'complete process exit',
  );
  assert.throws(
    () => process.kill(firstPid, 0),
    (error: NodeJS.ErrnoException) => error.code === 'ESRCH',
  );
  const preferences = JSON.parse(await readFile(path.join(profile, 'preferences.json'), 'utf8'));
  assert.equal(preferences.route, '#runs');
  JSON.parse(cdp('gateway', 'fleet.status', '{}'));
  record('Confirmed quit removes the background process and leaves the gateway running');
  await launch();
  assert.notEqual(pid, firstPid);
  await connected();
  assert.equal(value('location.hash'), '#runs');
  record('macOS relaunch starts a fresh connected client with its saved login and route');
  await writeFile(path.join(evidence, 'result.json'), JSON.stringify({ checks }, null, 2));
} catch (error) {
  console.error(String(error).replaceAll(token, '[redacted]'));
  process.exitCode = 1;
} finally {
  if (pid && (await available(inspector))) {
    // Clean up only this dedicated profile, including when the app under test is broken.
    await native('setTimeout(()=>e.app.exit(0),100);return true;');
    await wait(async () => !(await available(inspector)), 'fixture cleanup');
  }
}
