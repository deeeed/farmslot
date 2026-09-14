import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import WebSocket from 'ws';

import { ROOT } from '../lib/common.mjs';
import { writeEvidence } from '../lib/evidence.mjs';

export const SCENARIO_ID = 'native-owner-ui';
export const RUNNER_AGNOSTIC = true;

/** Observe actual browser traffic; retain method names, never credentials or frame payloads. */
export async function observePage(url) {
  const ws = new WebSocket(url);
  const pending = new Map();
  const methods = [];
  let sequence = 0;
  let observerError;
  ws.on('message', (raw) => {
    try {
      const message = JSON.parse(raw.toString());
      if (message.id && pending.has(message.id)) {
        const request = pending.get(message.id);
        pending.delete(message.id);
        clearTimeout(request.timer);
        if (message.error) request.reject(new Error(message.error.message));
        else request.resolve(message.result);
      }
      if (message.method === 'Network.webSocketFrameSent' && message.params.response.opcode === 1) {
        const frame = JSON.parse(message.params.response.payloadData);
        if (frame.type === 'req') methods.push(frame.method);
      }
    } catch (error) {
      observerError = error;
    }
  });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out observing ${method}`));
      }, 10000);
      pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
  await send('Network.enable');
  return {
    methods,
    send,
    check() {
      if (observerError) throw observerError;
    },
    close() {
      ws.close();
    },
  };
}

export async function runScenario({ explicit, outDir, timeoutMs = 30000 }) {
  if (!explicit) return { scenario: SCENARIO_ID, runner: 'native', pass: true, skipped: true };
  const report = { runner: 'native', checks: [], pass: false, methods: [] };
  let observer;
  const cdp = (...args) =>
    JSON.parse(
      execFileSync(process.execPath, ['apps/command-center/scripts/cdp.mjs', ...args], {
        cwd: ROOT,
        env: process.env,
        encoding: 'utf8',
        timeout: 30000,
      }),
    );
  const inspect = (route) =>
    cdp(
      'eval',
      route,
      `const view=document.querySelector('native-session-view');return {
        connected:view?.api?.connectionState==='connected',
        access:view?.api?.workspaceAccess,
        owner:view?.api?.authenticatedPrincipalId,
        native:Boolean(view),
        forbidden:[...document.querySelectorAll('fleet-canvas,run-list,run-detail,slot-view,chat-panel,terminal-split-view,config-panel')].map(e=>e.localName)
      };`,
    );
  try {
    const ui = new URL(process.env.FARMSLOT_UI_URL);
    assert.ok(['127.0.0.1', 'localhost'].includes(ui.hostname));
    assert.notEqual(ui.port, '5175', 'Never use the operator UI for access mutations');
    assert.equal(process.env.FARMSLOT_CDP_PORT, '19323');
    const tabs = await (await fetch('http://127.0.0.1:19323/json')).json();
    const target = tabs.find((tab) => tab.type === 'page' && tab.url.startsWith(ui.origin));
    assert.ok(target, 'Open and authenticate the private native-owner page first');
    observer = await observePage(target.webSocketDebuggerUrl);
    // Reload through the browser, with its existing real credential, to observe bootstrap.
    await observer.send('Page.reload', { ignoreCache: true });
    const deadline = Date.now() + timeoutMs;
    let state;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      state = inspect('native');
      if (state.connected && observer.methods.includes('native.session.catalog')) break;
    }
    assert.equal(state?.connected, true);
    assert.equal(state.access, 'native');
    assert.equal(state.owner, process.env.FARMSLOT_NATIVE_OWNER_UI_PRINCIPAL);
    assert.deepEqual(state.forbidden, []);
    for (const route of [
      'runs?native-owner-ui-proof=1',
      'slot/native-owner-ui-denied',
      'dev/native-owner-ui-denied',
    ]) {
      cdp('eval', 'native', `location.hash=${JSON.stringify('#' + route)};return true;`);
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.deepEqual(inspect(route), state, 'Protected route mounted a farm view');
      cdp('eval', route, "location.hash='#native';return true;");
    }
    // Include the shell's ten-second background poll boundary.
    await new Promise((resolve) => setTimeout(resolve, 11000));
    observer.check();
    report.methods = [...new Set(observer.methods)];
    for (const required of ['auth.connect', 'native.session.list', 'native.session.catalog'])
      assert.ok(report.methods.includes(required), `Missing real ${required} request`);
    const allowed = new Set([
      'auth.connect',
      'gateway.ping',
      'native.session.list',
      'native.session.catalog',
    ]);
    assert.deepEqual(
      report.methods.filter((method) => !allowed.has(method)),
      [],
      'Native-only client issued farm requests',
    );
    report.checks.push(
      'authenticated native owner; standalone view; protected routes; bootstrap and poll request allowlist',
    );
    fs.mkdirSync(outDir, { recursive: true });
    cdp('screenshot', 'native', path.join(outDir, 'native-owner-ui.png'));
    report.pass = true;
  } catch (error) {
    report.error = error.message;
    if (observer) report.methods = [...new Set(observer.methods)];
  } finally {
    observer?.close();
  }
  const outPath = writeEvidence(report, SCENARIO_ID, report.runner, outDir);
  return { scenario: SCENARIO_ID, runner: report.runner, pass: report.pass, outPath, report };
}
