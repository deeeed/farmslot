#!/usr/bin/env tsx
// Read-only gateway proof. Start a packaged app with the isolated profile below,
// CDP9497 and main inspector9498. Links are delivered by macOS, not injected into UI state.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';

import { confirmDesktopQuit } from './lib/desktop-quit.mjs';

const root = process.cwd();
const evidence = path.resolve('temp/desktop-links');
const profile = path.join(evidence, 'profile');
const app = path.resolve('apps/command-center-desktop/release/mac-arm64/Farmslot.app');
const port = process.env.FARMSLOT_CDP_PORT ?? '9497';
const inspector = process.env.FARMSLOT_DESKTOP_INSPECTOR_PORT ?? '9498';
const gateway = process.env.FARMSLOT_GATEWAY ?? 'ws://127.0.0.1:7801';
const token = process.env.FARMSLOT_GATEWAY_TOKEN;
const runId = process.env.FARMSLOT_TEST_RUN_ID;
const slotId = process.env.FARMSLOT_TEST_SLOT_ID;
assert(token && runId && slotId, 'Set gateway token and real test run/slot IDs');
assert.notEqual(port, '9473', 'Never test the operator profile');
process.on('uncaughtException', (error) => {
  console.error((error.stack ?? error.message).replaceAll(token, '[redacted]'));
  process.exit(1);
});
await mkdir(evidence, { recursive: true });
const env = { ...process.env, FARMSLOT_CDP_PORT: port, FARMSLOT_RPC_TIMEOUT_MS: '30000' };
function cdp(...args: string[]) {
  const result = execFileSync(process.execPath, ['apps/command-center/scripts/cdp.mjs', ...args], {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 40_000,
    stdio: 'pipe',
  });
  return result.trim();
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

function openLink(link: string) {
  execFileSync('/usr/bin/open', ['-a', app, link]);
}
async function connected() {
  await waitFor(() => value('document.querySelector("farm-app")?.connection === "connected"'));
}
async function expectRoute(route: string) {
  const [expectedPath, expectedQuery = ''] = route.split('?');
  await waitFor(() => {
    const [actualPath, actualQuery = ''] = String(value('location.hash')).split('?');
    const actual = new URLSearchParams(actualQuery);
    return (
      actualPath === expectedPath &&
      [...new URLSearchParams(expectedQuery)].every(
        ([key, expected]) => actual.get(key) === expected,
      )
    );
  });
}
async function verifyBadge() {
  await waitFor(() => value('document.querySelector("farm-app")?.hydrated === true'));
  const { decisions } = JSON.parse(cdp('gateway', 'decision.list', '{}'));
  // Run hydration can remove already-resolved inbox entries. Match the same
  // gateway-derived count the UI displays, including a legitimately empty inbox.
  let count = 0;
  await waitFor(async () => {
    count = value('document.querySelector("farm-app").decisionCount');
    return (await native('return e.app.dock.getBadge();')) === (count ? String(count) : '');
  });
  assert(Number.isSafeInteger(count) && count >= 0);
  assert(count <= decisions.length, 'Displayed decisions must come from the gateway inbox');
  return count;
}
const checks: string[] = [];
function record(message: string) {
  checks.push(message);
  console.log(message);
}
assert.equal(await native('return e.app.getPath("userData");'), profile);
assert.equal(JSON.parse(cdp('gateway', 'run.get', JSON.stringify({ runId }))).run.id, runId);
assert(
  JSON.parse(cdp('gateway', 'fleet.status', '{}')).fleet.slots.some(
    (slot: { slot: string }) => slot.slot === slotId,
  ),
);
openLink(`farmslot://gate/${runId}`);
await waitFor(
  () =>
    value('(async()=> (await window.farmslotDesktop.loadPreferences()).route)()') ===
    `#runs?run=${runId}`,
);
assert.equal(value('location.pathname'), '/settings');
cdp('fill', '-', '#gateway-url', gateway);
cdp('fill', '-', '#secret', token);
cdp('click', '-', '#connection-form button');
await connected();
await expectRoute(`#runs?run=${runId}`);
record('macOS link waits for login and opens the real run gate');
const count = await verifyBadge();
record('Dock badge matches gateway-derived pending decisions shown in the UI');
await native(
  'e.Menu.getApplicationMenu().getMenuItemById("copy-desktop-link").click();return true;',
);
await waitFor(
  () =>
    execFileSync('/usr/bin/pbpaste', { encoding: 'utf8', timeout: 5000 }) ===
    `farmslot://run/${runId}`,
);
record('native menu copies a credential-free run link');
await native('e.BrowserWindow.getAllWindows()[0].hide();return true;');
openLink(`farmslot://slot/${slotId}`);
await expectRoute(`#slot/${slotId}`);
assert.equal(await native('return e.BrowserWindow.getAllWindows()[0].isVisible();'), true);
record('macOS slot link restores a hidden window');
await native('e.BrowserWindow.getAllWindows()[0].minimize();return true;');
openLink(`farmslot://run/${runId}`);
await expectRoute(`#runs?run=${runId}`);
assert.equal(await native('return e.BrowserWindow.getAllWindows()[0].isMinimized();'), false);
record('macOS run link restores a minimized window');
await native(
  'const menu=e.Menu.getApplicationMenu();menu.items.flatMap(i=>i.submenu?.items??[]).find(i=>i.label==="Connection Settings…").click();return true;',
);
await waitFor(() => value('location.pathname') === '/settings');
assert.equal(await native('return e.app.dock.getBadge();'), '');
assert.equal(
  await native('return e.Menu.getApplicationMenu().getMenuItemById("copy-desktop-link").enabled;'),
  false,
);
record('badge clears when the gateway UI disconnects and settings cannot copy a stale link');
cdp('click', '-', '#cancel');
await connected();
await verifyBadge();
openLink('farmslot://fleet');
await expectRoute('#fleet');
await quit();
execFileSync('/usr/bin/open', [
  '-n',
  '-a',
  app,
  '--env',
  `FARMSLOT_DESKTOP_USER_DATA=${profile}`,
  '--env',
  `FARMSLOT_DESKTOP_CDP_PORT=${port}`,
  `farmslot://gate/${runId}`,
  '--args',
  `--inspect=127.0.0.1:${inspector}`,
]);
await waitFor(async () => {
  try {
    return (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).some(
      (target: { type: string }) => target.type === 'page',
    );
  } catch {
    return false;
  } // Cold launch has not opened its debugger endpoint yet.
});
await connected();
await expectRoute(`#runs?run=${runId}`);
await verifyBadge();
record('cold macOS URL launch restores login and opens the requested gate');
await quit();
const result = { status: 'pass', count, checks };
await writeFile(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
