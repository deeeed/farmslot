#!/usr/bin/env node
// Reusable Farmslot UI CDP + gateway RPC helper.
//
// Usage:
//   node scripts/cdp.mjs eval <hash|-|<route#hash>> <expr>  Evaluate JS in a page tab (- = first tab).
//   node scripts/cdp.mjs eval <hash> --file <path>    Evaluate the file contents in page context.
//   node scripts/cdp.mjs login <hash>                 Fill the auth form from env token/password.
//   node scripts/cdp.mjs screenshot <hash> <path>      Capture a PNG screenshot of a page tab.
//   node scripts/cdp.mjs tabs                         List CDP tabs.
//   node scripts/cdp.mjs gateway <method> [paramsJson] Send a JSON-RPC request to ws://localhost:7777.
//
// Env:
//   FARMSLOT_CDP_PORT   CDP port (default 9323).
//   FARMSLOT_GATEWAY    Gateway WS url (default ws://localhost:7777).
//   FARMSLOT_GATEWAY_TOKEN/PASSWORD are read from process env or nearest .env.local-auth/.env.
//
// Exit codes: 0 on success, 1 on usage error, 2 on runtime error (no tab / WS failure).

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import WebSocket from 'ws';

const CDP_PORT = process.env.FARMSLOT_CDP_PORT ?? '9323';
const GATEWAY_URL = process.env.FARMSLOT_GATEWAY ?? 'ws://localhost:7777';
const GATEWAY_CREDENTIAL = resolveGatewayCredential();
const [, , cmd, ...rest] = process.argv;

function die(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

async function listTabs() {
  const res = await fetch(`http://localhost:${CDP_PORT}/json`);
  if (!res.ok) die(`CDP not reachable on :${CDP_PORT} (status ${res.status})`, 2);
  return res.json();
}

async function findTab(hash) {
  const tabs = await listTabs();
  const pages = tabs.filter((t) => t.type === 'page');
  if (!hash || hash === '-') return pages[0];
  const needle = hash.startsWith('#') ? hash : `#${hash}`;
  // Intentionally no fallback to pages[0] when a hash is specified: silently
  // retargeting to another tab lets validation scripts "pass" against an
  // unrelated page or mutate the wrong one. Caller handles null → die.
  return pages.find((t) => t.url?.includes(needle)) ?? null;
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    let id = 0;
    ws.on('message', (buf) => {
      const msg = JSON.parse(buf);
      if (msg.id && pending.has(msg.id)) {
        const { resolve: r, reject: rj } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? rj(new Error(msg.error.message ?? 'cdp error')) : r(msg.result);
      }
    });
    ws.on('error', reject);
    ws.once('open', () =>
      resolve({
        call(method, params = {}) {
          return new Promise((res, rej) => {
            const i = ++id;
            pending.set(i, { resolve: res, reject: rej });
            ws.send(JSON.stringify({ id: i, method, params }));
          });
        },
        close() {
          ws.close();
        },
      }),
    );
  });
}

async function evalInTab(hash, expr) {
  const tab = await findTab(hash);
  if (!tab) die(`no CDP tab matching hash=${hash || '(any)'}`, 2);
  const { call, close } = await connect(tab.webSocketDebuggerUrl);
  await call('Runtime.enable');
  // Always try the implicit-return expression form first so bare snippets
  // like `document.title` return their value. Fall back to the body form
  // only on a SyntaxError (statements, multi-line blocks, explicit `return`).
  // This avoids regex heuristics that false-positive on `;` or `return`
  // inside string literals — the parser is authoritative.
  const trimmed = expr.trim();
  const exprForm = `(async () => (${trimmed}))()`;
  const stmtForm = `(async () => { ${trimmed} })()`;
  let r = await call('Runtime.evaluate', {
    expression: exprForm,
    awaitPromise: true,
    returnByValue: true,
  });
  // Chrome splits the diagnostic across fields: `text` is usually "Uncaught"
  // and `exception.description` carries the actual "SyntaxError: ..." line.
  // Match on either so the fallback fires for any parse failure.
  const exceptionText = [
    r.exceptionDetails?.text ?? '',
    r.exceptionDetails?.exception?.description ?? '',
  ].join(' ');
  if (r.exceptionDetails && /SyntaxError/.test(exceptionText)) {
    r = await call('Runtime.evaluate', {
      expression: stmtForm,
      awaitPromise: true,
      returnByValue: true,
    });
  }
  close();
  if (r.exceptionDetails)
    die(
      `eval threw: ${r.exceptionDetails.text}\n${r.exceptionDetails.exception?.description ?? ''}`,
      2,
    );
  return r.result?.value;
}

async function screenshotTab(hash, outputPath) {
  const tab = await findTab(hash);
  if (!tab) die(`no CDP tab matching hash=${hash || '(any)'}`, 2);
  const { call, close } = await connect(tab.webSocketDebuggerUrl);
  await call('Page.enable');
  await call('Runtime.evaluate', {
    expression: 'document.fonts?.ready ?? Promise.resolve()',
    awaitPromise: true,
    returnByValue: true,
  });
  const result = await call('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
    fromSurface: true,
  });
  close();
  writeFileSync(outputPath, Buffer.from(result.data, 'base64'));
  return { path: outputPath };
}

async function loginInTab(hash) {
  const secret = GATEWAY_CREDENTIAL?.token ?? GATEWAY_CREDENTIAL?.password;
  const mode = GATEWAY_CREDENTIAL?.token ? 'token' : 'password';
  if (!secret) die('login requires FARMSLOT_GATEWAY_TOKEN or FARMSLOT_GATEWAY_PASSWORD', 2);
  return evalInTab(
    hash,
    `
      const secret = ${JSON.stringify(secret)};
      const mode = ${JSON.stringify(mode)};
      const deadline = Date.now() + 5000;
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      while (!document.querySelector('.auth-card') && Date.now() < deadline) await sleep(50);
      const activeMode = document.querySelector('.auth-mode.active')?.textContent?.trim()?.toLowerCase();
      if (activeMode !== mode) {
        const modeButton = Array.from(document.querySelectorAll('.auth-mode')).find(
          (button) => button.textContent?.trim()?.toLowerCase() === mode,
        );
        if (!modeButton) throw new Error('auth mode button not found');
        modeButton.click();
        await sleep(50);
      }
      const input = document.querySelector('.auth-input');
      if (!input) throw new Error('auth input not found');
      input.focus();
      input.value = secret;
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: secret }));
      const form = document.querySelector('.auth-card');
      if (!(form instanceof HTMLFormElement)) throw new Error('auth form not found');
      form.requestSubmit();
      while (document.querySelector('.auth-card') && Date.now() < deadline) await sleep(100);
      return {
        authenticated: !document.querySelector('.auth-card'),
        bodyText: document.body.innerText.slice(0, 300),
      };
    `,
  );
}

async function gatewayRpc(method, paramsJson) {
  const params = paramsJson ? JSON.parse(paramsJson) : {};
  const ws = new WebSocket(GATEWAY_URL);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('gateway RPC timeout'));
    }, 5000);
    let authed = false;
    ws.once('open', () =>
      ws.send(
        JSON.stringify({
          type: 'req',
          id: 'auth-1',
          method: 'auth.connect',
          params: {
            clientKind: 'ui',
            clientName: 'farmslot-cdp-script',
            ...(GATEWAY_CREDENTIAL?.token ? { token: GATEWAY_CREDENTIAL.token } : {}),
            ...(GATEWAY_CREDENTIAL?.password ? { password: GATEWAY_CREDENTIAL.password } : {}),
          },
        }),
      ),
    );
    ws.on('message', (buf) => {
      const msg = JSON.parse(buf);
      if (msg.id === 'auth-1') {
        if (!msg.ok) {
          clearTimeout(timer);
          ws.close();
          reject(new Error(JSON.stringify(msg)));
          return;
        }
        authed = true;
        ws.send(JSON.stringify({ type: 'req', id: '1', method, params }));
        return;
      }
      if (authed && msg.id === '1') {
        clearTimeout(timer);
        ws.close();
        msg.ok ? resolve(msg.payload ?? msg.result) : reject(new Error(JSON.stringify(msg)));
      }
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function resolveGatewayCredential() {
  const envCredential = credentialFromEnv(process.env);
  if (envCredential) return envCredential;

  for (const envFile of findGatewayEnvFiles()) {
    const parsed = readEnvFile(envFile);
    const credential = credentialFromEnv(parsed);
    if (credential) return credential;
  }

  return null;
}

function credentialFromEnv(env) {
  const password = nonEmpty(env.FARMSLOT_GATEWAY_PASSWORD);
  if (password) return { password };
  const token = nonEmpty(env.FARMSLOT_GATEWAY_TOKEN);
  if (token) return { token };
  return null;
}

function findGatewayEnvFiles() {
  const roots = new Set();
  if (process.env.FARMSLOT_ROOT) roots.add(resolve(process.env.FARMSLOT_ROOT));

  let cwd = resolve(process.cwd());
  while (true) {
    roots.add(cwd);
    const parent = dirname(cwd);
    if (parent === cwd) break;
    cwd = parent;
  }

  const scriptDir = dirname(fileURLToPath(import.meta.url));
  roots.add(resolve(scriptDir, '..'));
  roots.add(resolve(scriptDir, '../..'));

  const files = [];
  for (const root of roots) {
    for (const name of ['.env.local-auth', '.env']) {
      const file = resolve(root, name);
      if (existsSync(file) && !files.includes(file)) files.push(file);
    }
  }
  return files;
}

function readEnvFile(path) {
  const result = {};
  for (const rawLine of readFileSync(path, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const normalized = line.startsWith('export ') ? line.slice('export '.length).trim() : line;
    const eqIdx = normalized.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = normalized.slice(0, eqIdx).trim();
    let value = normalized.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

try {
  if (cmd === 'tabs') {
    console.log(JSON.stringify(await listTabs(), null, 2));
  } else if (cmd === 'eval') {
    const [hash, flag, ...tail] = rest;
    if (!hash) die('usage: cdp.mjs eval <hash|-|<route#hash>> <expr | --file path>');
    let expr;
    if (flag === '--file') expr = readFileSync(tail[0], 'utf8');
    else expr = [flag, ...tail].join(' ');
    if (!expr) die('missing expression');
    const value = await evalInTab(hash, expr);
    console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  } else if (cmd === 'login') {
    const [hash] = rest;
    if (!hash) die('usage: cdp.mjs login <hash>');
    const result = await loginInTab(hash);
    console.log(JSON.stringify(result, null, 2));
  } else if (cmd === 'screenshot') {
    const [hash, outputPath] = rest;
    if (!hash || !outputPath) die('usage: cdp.mjs screenshot <hash|-|route> <output.png>');
    const result = await screenshotTab(hash, outputPath);
    console.log(JSON.stringify(result, null, 2));
  } else if (cmd === 'gateway') {
    const [method, paramsJson] = rest;
    if (!method) die('usage: cdp.mjs gateway <method> [paramsJson]');
    const result = await gatewayRpc(method, paramsJson);
    console.log(JSON.stringify(result, null, 2));
  } else {
    die('usage: cdp.mjs <tabs | eval | login | screenshot | gateway> ...');
  }
} catch (err) {
  die(`cdp.mjs: ${err.message}`, 2);
}
