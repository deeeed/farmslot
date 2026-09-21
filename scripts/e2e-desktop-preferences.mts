#!/usr/bin/env tsx
// Local-only UI proof against an existing gateway. Start a packaged test app with
// a dedicated profile, CDP port and main inspector; never use the operator profile.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, openSync, closeSync } from 'node:fs';
import { readFile, readdir, stat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';

import { confirmDesktopQuit } from './lib/desktop-quit.mjs';

const root = process.cwd();
const evidence = path.resolve('temp/desktop-preferences');
const profile = path.join(evidence, 'profile');
const port = process.env.FARMSLOT_CDP_PORT ?? '9493';
const inspector = process.env.FARMSLOT_DESKTOP_INSPECTOR_PORT ?? '9494';
const gateway = process.env.FARMSLOT_GATEWAY ?? 'ws://127.0.0.1:7801';
const token = process.env.FARMSLOT_GATEWAY_TOKEN;
assert(token, 'Set FARMSLOT_GATEWAY_TOKEN without printing it');
process.on('uncaughtException', (error) => {
  console.error(error.message.replaceAll(token, '[redacted]'));
  process.exit(1);
});
assert.notEqual(port, '9473', 'Do not use the operator app');
const originalApp = path.resolve('apps/command-center-desktop/release/mac-arm64/Farmslot.app');
const encrypted = path.join(profile, 'connection.encrypted');
await mkdir(evidence, { recursive: true });
const env = { ...process.env, FARMSLOT_CDP_PORT: port };
function cdp(...args: string[]) {
  const result = execFileSync(process.execPath, ['apps/command-center/scripts/cdp.mjs', ...args], {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 20_000,
    stdio: 'pipe',
  });
  return result.trim();
}
function value(expression: string) {
  return JSON.parse(cdp('eval', '-', `return {value:(${expression})};`)).value;
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
async function waitFor(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 60; i++) {
    if (await check()) return;
    await delay(500);
  }
  throw new Error('Desktop condition timed out');
}
async function quit() {
  const quittingPid = await native('setTimeout(()=>e.app.quit(),100);return process.pid;');
  confirmDesktopQuit(quittingPid);
  await waitFor(async () => {
    try {
      await fetch(`http://127.0.0.1:${port}/json/list`);
      return false;
    } catch {
      return true;
    } // The debugger closing is the expected quit acknowledgement.
  });
}
async function launch(app: string) {
  const output = openSync(path.join(evidence, 'app.log'), 'a');
  const child = spawn(
    path.join(app, 'Contents/MacOS/Farmslot'),
    [`--inspect=127.0.0.1:${inspector}`],
    {
      env: { ...process.env, FARMSLOT_DESKTOP_USER_DATA: profile, FARMSLOT_DESKTOP_CDP_PORT: port },
      detached: true,
      stdio: ['ignore', output, output],
    },
  );
  child.unref();
  closeSync(output);
  await waitFor(async () => {
    try {
      return (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).some(
        (t: any) => t.type === 'page',
      );
    } catch {
      return false;
    } // Wait for the new test process to expose CDP.
  });
  await waitFor(() => value('document.readyState === "complete"'));
}
async function connected() {
  await waitFor(() => value('document.querySelector("farm-app")?.connection === "connected"'));
}
async function settings() {
  cdp('eval', '-', 'location.href="/settings"; return true;');
  await waitFor(() => value('Boolean(document.querySelector("#remember-me"))'));
}
async function noPlaintext(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await noPlaintext(file);
    else if (entry.isFile())
      assert(!(await readFile(file)).includes(token!), `Plaintext credential in ${entry.name}`);
  }
}
const checks: string[] = [];
assert.equal(
  await native('return e.app.getPath("userData");'),
  profile,
  'Only test the isolated profile',
);
assert.equal(value('document.querySelector("#remember-me").checked'), true);
cdp('fill', '-', '#gateway-url', gateway);
cdp('fill', '-', '#secret', token);
cdp('click', '-', '#connection-form button');
await connected();
assert(existsSync(encrypted));
assert(!(await readFile(encrypted)).includes(token));
assert.equal((await stat(encrypted)).mode & 0o777, 0o600);
checks.push('default remembered login connects and writes encrypted credentials');
cdp('eval', '-', 'location.hash="#runs"; return true;');
await native(
  'e.BrowserWindow.getAllWindows()[0].setBounds({x:80,y:80,width:1100,height:760});return true;',
);
await delay(500);
const bounds = await native('return e.BrowserWindow.getAllWindows()[0].getNormalBounds();');
await native('e.BrowserWindow.getAllWindows()[0].close();return true;');
assert.equal(await native('return e.BrowserWindow.getAllWindows()[0].isVisible();'), false);
await native('e.BrowserWindow.getAllWindows()[0].show();return true;');
checks.push('window close hides the app and preserves its running connection');
await settings();
cdp('fill', '-', '#shortcut', 'CommandOrControl+Shift+F');
cdp('click', '-', '#desktop-form button');
await waitFor(() =>
  value('document.querySelector("#shortcut-status").textContent === "Shortcut saved."'),
);
assert.equal(
  await native('return e.globalShortcut.isRegistered("CommandOrControl+Shift+F");'),
  true,
);
assert.equal(
  await native('return e.globalShortcut.isRegistered("CommandOrControl+Shift+Space");'),
  false,
);
checks.push('configured shortcut replaces the old native registration');
cdp('click', '-', '#cancel');
await connected();
await quit();
await noPlaintext(profile);
const replacement = path.join(evidence, 'replacement/Farmslot.app');
await mkdir(path.dirname(replacement), { recursive: true });
assert(!existsSync(replacement), 'Use a fresh evidence directory');
execFileSync('/bin/cp', ['-cR', originalApp, replacement]);
await launch(replacement);
await connected();
assert.equal(value('location.hash'), '#runs');
assert.deepEqual(
  await native('return e.BrowserWindow.getAllWindows()[0].getNormalBounds();'),
  bounds,
);
assert.equal(
  await native('return e.globalShortcut.isRegistered("CommandOrControl+Shift+F");'),
  true,
);
checks.push('replacement app restores encrypted login, last route, bounds and shortcut');
cdp('screenshot', '-', path.join(evidence, 'remembered-relaunch.png'));
await settings();
assert.equal(value('document.querySelector("#remember-me").checked'), true);
cdp('click', '-', '#remember-me');
cdp('click', '-', '#connection-form button');
await connected();
assert(!existsSync(encrypted));
cdp('eval', '-', 'location.reload(); return true;');
await connected();
checks.push('opting out deletes saved credentials and survives a renderer reload');
await quit();
await noPlaintext(profile);
await launch(replacement);
await waitFor(() => value('Boolean(document.querySelector("#secret"))'));
assert.equal(value('document.querySelector("#secret").value'), '');
checks.push('session-only credentials are absent after a full quit');
cdp('screenshot', '-', path.join(evidence, 'session-only-relaunch.png'));
cdp('fill', '-', '#gateway-url', gateway);
cdp('fill', '-', '#secret', 'invalid-local-test-token');
cdp('click', '-', '#remember-me');
cdp('click', '-', '#connection-form button');
await waitFor(() => value('Boolean(document.querySelector(".auth-remember input"))'));
assert.equal(value('document.querySelector(".auth-remember input").checked'), false);
cdp('screenshot', '-', path.join(evidence, 'desktop-login.png'));
cdp('fill', '-', '.auth-input', token);
cdp('click', '-', '.auth-remember input');
cdp('click', '-', '.auth-submit');
await connected();
assert(existsSync(encrypted));
checks.push('shared desktop login preserves opt-out and can enable remembered credentials');
await quit();
await noPlaintext(profile);
console.log(JSON.stringify({ status: 'pass', checks, evidence }));
