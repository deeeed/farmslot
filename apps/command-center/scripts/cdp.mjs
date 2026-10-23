#!/usr/bin/env node
// Reusable Farmslot UI CDP + gateway RPC helper.
//
// Usage:
//   node scripts/cdp.mjs eval <hash|-|<route#hash>> <expr>  Evaluate JS in a page tab (- = first tab).
//   node scripts/cdp.mjs eval <hash> --file <path>    Evaluate the file contents in page context.
//   node scripts/cdp.mjs eval <hash> --file <p> --out <f>  Also write the result JSON to a file (evidence).
//   node scripts/cdp.mjs focus <hash>                 Front the tab + grant clipboard (probes that click copy buttons).
//   node scripts/cdp.mjs goto <hash|url> [--new]      Navigate a reused Command Center tab.
//   node scripts/cdp.mjs login <hash>                 Fill the auth form from an explicit test profile.
//   node scripts/cdp.mjs screenshot <hash> <path> [--appearance dark|light] [--width N --height N]
//   node scripts/cdp.mjs viewport <hash> <width> <height> Resize the browser content area.
//   node scripts/cdp.mjs fill <hash> <selector> <text> Type into a control with real CDP input.
//   node scripts/cdp.mjs click <hash> <selector>       Click a control, searching shadow roots.
//   node scripts/cdp.mjs click <hash> <selector> --observe-file <path>  Read a probe immediately after the real click.
//   node scripts/cdp.mjs key <hash> <1-9|Enter|Escape|Tab> Send a real key to the focused control.
//   node scripts/cdp.mjs select <hash> <selector> <value> Choose a styled choice or native select option.
//   Selectors may cross shadow roots with >>>, e.g. native-session-view >>> textarea.
//   node scripts/cdp.mjs tabs                         List CDP tabs.
//   node scripts/cdp.mjs close <hash>                 Close a matching tab.
//   node scripts/cdp.mjs gateway <method> [paramsJson] Send a JSON-RPC request to ws://localhost:7777.
//   node scripts/cdp.mjs baseline <hash> <cold|reconnect|diff> [gate-route] Measure actual websocket reads.
//   node scripts/cdp.mjs idle-reads <hash> <ms> <methodsJson> Count outgoing reads in a settled page.
//
// Env:
//   FARMSLOT_CDP_PORT   CDP port (default 9323).
//   FARMSLOT_CDP_HOST   CDP address (default 127.0.0.1); must match debug-chrome.sh.
//   FARMSLOT_UI_URL     Command Center URL used by `goto` for hash targets (default from .env.ports VITE_PORT, else 5174).
//   FARMSLOT_GATEWAY    Gateway WS url (default ws://localhost:7777).
//   FARMSLOT_GATEWAY_PROFILE names an explicit automation/test profile in FARMSLOT_HOME.
//
// Exit codes: 0 on success, 1 on usage error, 2 on runtime error (no tab / WS failure).

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import WebSocket from 'ws';

import { automationGatewayTarget } from '../../../scripts/lib/gateway-profile.mjs';

import {
  measureOfflineClientStore,
  observeIdleGatewayReads,
} from './offline-client-store-baseline.mjs';

const CDP_PORT = process.env.FARMSLOT_CDP_PORT ?? '9323';
// Must match debug-chrome.sh: it verifies which process owns CDP at this exact
// address before allowing us to drive it. Connecting to "localhost" here would let
// resolution pick a different socket than the one that was checked.
const CDP_HOST = process.env.FARMSLOT_CDP_HOST ?? '127.0.0.1';
const UI_URL = process.env.FARMSLOT_UI_URL ?? defaultUiUrl();
const [, , cmd, ...rest] = process.argv;
const gatewayTarget = cmd === 'gateway' || cmd === 'login' ? await automationGatewayTarget() : null;
const GATEWAY_URL = gatewayTarget?.url ?? process.env.FARMSLOT_GATEWAY ?? 'ws://localhost:7777';
const GATEWAY_CREDENTIAL = gatewayTarget?.credential ?? null;

function defaultUiUrl() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const portFile = resolve(scriptDir, '../../../.env.ports');
  const port = existsSync(portFile)
    ? (readFileSync(portFile, 'utf8').match(/^VITE_PORT=(\d+)\s*$/m)?.[1] ?? '5174')
    : '5174';
  return `http://localhost:${port}`;
}

function die(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

async function listTabs() {
  const res = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json`);
  if (!res.ok) die(`CDP not reachable on :${CDP_PORT} (status ${res.status})`, 2);
  return res.json();
}

function commandCenterUrl(target) {
  if (!target) die('missing target');
  if (/^https?:\/\//.test(target)) return target;
  const url = new URL(UI_URL);
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  url.hash = target.startsWith('#') ? target.slice(1) : target;
  return url.href;
}

function matchesNavigatedRoute(actualUrl, expectedUrl) {
  const actual = new URL(actualUrl);
  const expected = new URL(expectedUrl);
  if (actual.origin !== expected.origin || actual.pathname !== expected.pathname) return false;
  if (expected.hash.includes('?')) return actual.hash === expected.hash;
  return actual.hash === expected.hash || actual.hash.startsWith(`${expected.hash}?`);
}

async function findTab(hash) {
  const tabs = await listTabs();
  const pages = tabs.filter((t) => t.type === 'page');
  if (!hash || hash === '-') return pages[0];
  if (hash.startsWith('@')) return pages.find((tab) => tab.id === hash.slice(1)) ?? null;
  const needle = hash.startsWith('#') ? hash : `#${hash}`;
  // Intentionally no fallback to pages[0] when a hash is specified: silently
  // retargeting to another tab lets validation scripts "pass" against an
  // unrelated page or mutate the wrong one. Caller handles null → die.
  return pages.find((t) => t.url?.includes(needle)) ?? null;
}

async function createTab(url) {
  const res = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/new?${encodeURIComponent(url)}`, {
    method: 'PUT',
  });
  if (!res.ok) die(`failed to create CDP tab on :${CDP_PORT} (status ${res.status})`, 2);
  return res.json();
}

async function findReusableTab(url) {
  const target = new URL(url);
  const pages = (await listTabs()).filter((t) => t.type === 'page');
  const parseUrl = (value) => {
    try {
      return new URL(value);
    } catch {
      return null;
    }
  };
  const sameOrigin = pages.filter((tab) => parseUrl(tab.url)?.origin === target.origin);
  return (
    sameOrigin.find((tab) => {
      const current = parseUrl(tab.url);
      return current?.pathname === target.pathname && current.hash === target.hash;
    }) ??
    sameOrigin[0] ??
    null
  );
}

function connect(wsUrl, onEvent) {
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
      } else if (msg.method && onEvent) {
        onEvent(msg);
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForNavigatedRoute(call, url) {
  let lastSeen = '(no page context)';
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const result = await call('Runtime.evaluate', {
        expression: '({ href: window.location.href, readyState: document.readyState })',
        returnByValue: true,
      });
      const value = result.result?.value;
      if (value?.href) lastSeen = value.href;
      if (
        value?.href &&
        value.readyState === 'complete' &&
        matchesNavigatedRoute(value.href, url)
      ) {
        return value.href;
      }
    } catch (error) {
      // Expected while Chrome swaps execution contexts during navigation.
      lastSeen = error instanceof Error ? error.message : String(error);
    }
    await sleep(100);
  }
  die(`CDP navigation reached ${lastSeen} instead of ${url}`, 2);
}

async function navigateTab(target, forceNew = false) {
  const url = commandCenterUrl(target);
  let reused = false;
  let tab = forceNew ? null : await findReusableTab(url);
  if (tab) {
    reused = true;
  } else {
    tab = await createTab(url);
  }
  const { call, close } = await connect(tab.webSocketDebuggerUrl);
  await call('Page.enable');
  await call('Runtime.enable');
  await call('Page.navigate', { url });
  await waitForNavigatedRoute(call, url);
  close();
  return { id: tab.id, url, reused };
}

/**
 * Make a tab the active, focused one and grant it clipboard access.
 *
 * A probe's `element.click()` carries no user activation, so a copy button's
 * `navigator.clipboard.writeText` rejects with "Document is not focused" in a
 * background tab and "Write permission denied" without the granted permission.
 * Both are browser gates on the automation, not app behaviour — the probe still
 * drives the real button and the real RPC.
 */
async function focusTab(hash) {
  const tab = await findTab(hash);
  if (!tab) die(`no CDP tab matching hash=${hash || '(any)'}`, 2);
  const { call, close } = await connect(tab.webSocketDebuggerUrl);
  await call('Page.enable');
  await call('Page.bringToFront');
  const deadline = Date.now() + 5000;
  let visibility;
  do {
    visibility = await call('Runtime.evaluate', {
      expression: 'document.visibilityState',
      returnByValue: true,
    });
    if (visibility.result?.value === 'visible') break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  close();
  if (visibility.result?.value !== 'visible') die('The selected tab did not become visible', 2);
  const origin = new URL(tab.url).origin;
  // `about:blank` and similar yield the literal string "null", which would make
  // the permission grant a silent no-op.
  if (origin === 'null') die(`tab ${tab.url} has no origin to grant clipboard access to`, 2);
  const versionRes = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/version`);
  if (!versionRes.ok) die(`CDP not reachable on :${CDP_PORT}`, 2);
  const { webSocketDebuggerUrl } = await versionRes.json();
  const browser = await connect(webSocketDebuggerUrl);
  await browser.call('Browser.grantPermissions', {
    origin,
    permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
  });
  browser.close();
  return {
    id: tab.id,
    url: tab.url,
    origin,
    clipboardGranted: true,
    visibility: visibility.result?.value,
  };
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

async function keyInTab(hash, key) {
  const keyCode =
    { Enter: 13, Escape: 27, Tab: 9 }[key] ?? (/^[1-9]$/.test(key) ? key.charCodeAt(0) : undefined);
  if (keyCode === undefined) die('key supports 1-9, Enter, Escape or Tab');
  const tab = await findTab(hash);
  if (!tab) die(`no CDP tab matching hash=${hash}`, 2);
  const { call, close } = await connect(tab.webSocketDebuggerUrl);
  try {
    const code = /^[1-9]$/.test(key) ? `Digit${key}` : key;
    const event = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
    await call('Input.dispatchKeyEvent', { type: 'keyDown', ...event });
    await call('Input.dispatchKeyEvent', { type: 'keyUp', ...event });
    return { key };
  } finally {
    close();
  }
}

async function viewportTab(hash, width, height) {
  if (![width, height].every((value) => Number.isSafeInteger(value) && value > 0))
    die('Use positive viewport dimensions');
  const tab = await findTab(hash);
  if (!tab) die(`no CDP tab matching hash=${hash}`, 2);
  const { call, close } = await connect(tab.webSocketDebuggerUrl);
  try {
    const { windowId } = await call('Browser.getWindowForTarget', { targetId: tab.id });
    await call('Browser.setContentsSize', { windowId, width, height });
    return { width, height };
  } finally {
    close();
  }
}

async function screenshotTab(hash, outputPath, options) {
  const { appearance, width, height } = options;
  if (appearance && !['dark', 'light'].includes(appearance)) die('Use dark or light appearance');
  if (
    (width !== undefined || height !== undefined) &&
    ![width, height].every((value) => Number.isSafeInteger(value) && value > 0)
  )
    die('Use positive --width and --height together');
  const tab = await findTab(hash);
  if (!tab) die(`no CDP tab matching hash=${hash || '(any)'}`, 2);
  const { call, close } = await connect(tab.webSocketDebuggerUrl);
  try {
    await call('Page.enable');
    if (width !== undefined)
      await call('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false,
      });
    if (appearance)
      await call('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-color-scheme', value: appearance }],
      });
    // Emulation belongs to this CDP connection, so retain it through the capture.
    await call('Runtime.evaluate', {
      expression: 'document.fonts?.ready ?? Promise.resolve()',
      awaitPromise: true,
      returnByValue: true,
    });
    const presentation = await call('Runtime.evaluate', {
      expression:
        '({ width: innerWidth, height: innerHeight, appearance: matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark" })',
      returnByValue: true,
    });
    const result = await call('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      fromSurface: true,
    });
    writeFileSync(outputPath, Buffer.from(result.data, 'base64'));
    return { path: outputPath, ...presentation.result?.value };
  } finally {
    close();
  }
}

async function clickInTab(hash, selector, dialogChoice, expectedDialog, observationSource) {
  const tab = await findTab(hash);
  if (!tab) die(`no CDP tab matching hash=${hash}`, 2);
  let dialog, dialogResult, dialogError;
  const { call, close } = await connect(tab.webSocketDebuggerUrl, (event) => {
    if (event.method !== 'Page.javascriptDialogOpening' || !dialogChoice) return;
    dialog = event.params.message;
    const matches = event.params.type === 'confirm' && dialog === expectedDialog;
    dialogResult = call('Page.handleJavaScriptDialog', {
      accept: matches && dialogChoice === 'accept',
    }).catch((error) => {
      dialogError = error;
    });
    if (!matches) dialogError = new Error('Confirmation dialog did not match the expected message');
  });
  try {
    if (dialogChoice) await call('Page.enable');
    await call('Page.bringToFront');
    const clickDeadline = Date.now() + 5000;
    let result;
    do {
      result = await call('Runtime.evaluate', {
        expression: `(() => {
        const parts = ${JSON.stringify(selector)}.split('>>>').map(part=>part.trim());
        function find(root, part) {
          const element = root.querySelector(part);
          if (element) return element;
          for (const child of root.querySelectorAll('*')) {
            if (child.shadowRoot) { const found=find(child.shadowRoot,part); if(found)return found; }
          }
        }
        let root=document, element;
        for (const [index,part] of parts.entries()) {
          element=parts.length===1 ? find(root,part) : root?.querySelector(part);
          if (index < parts.length-1) root=element?.shadowRoot;
        }
        if(!element) throw Error('Click target unavailable: missing');
        if(element.disabled) throw Error('Click target unavailable: disabled');
        element.scrollIntoView({block:'center'});
        if(!element.getClientRects().length) throw Error('Click target unavailable: hidden');
        const rect=element.getBoundingClientRect();
        return {x:rect.x+rect.width/2,y:rect.y+rect.height/2};
      })()`,
        returnByValue: true,
      });
      if (!result.exceptionDetails) break;
      const message =
        result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
      if (!message.includes('Click target unavailable') || Date.now() >= clickDeadline)
        throw new Error(message);
      await new Promise((resolve) => setTimeout(resolve, 25));
    } while (Date.now() < clickDeadline);
    if (result.exceptionDetails) throw new Error('Click target unavailable before deadline');
    const clickedAt = Date.now();
    for (const type of ['mousePressed', 'mouseReleased'])
      await call('Input.dispatchMouseEvent', {
        type,
        ...result.result.value,
        button: 'left',
        clickCount: 1,
      });
    if (dialogChoice) {
      await dialogResult;
      if (dialogError) throw dialogError;
      if (dialog === undefined) throw new Error('Expected confirmation dialog did not open');
    }
    if (observationSource !== undefined) {
      const observed = await call('Runtime.evaluate', {
        expression: `(async () => { ${observationSource}\n })()`,
        awaitPromise: true,
        returnByValue: true,
      });
      if (observed.exceptionDetails)
        throw new Error(
          observed.exceptionDetails.exception?.description ?? observed.exceptionDetails.text,
        );
      return { clicked: selector, clickedAt, observation: observed.result.value };
    }
    return { clicked: selector };
  } finally {
    close();
  }
}

async function inputInTab(hash, selector, value, select) {
  const tab = await findTab(hash);
  if (!tab) die(`no CDP tab matching hash=${hash}`, 2);
  const { call, close } = await connect(tab.webSocketDebuggerUrl);
  const resolveControl = `let root=document, control;
    for (const part of ${JSON.stringify(selector)}.split('>>>')) {
      control=root?.querySelector(part.trim()); root=control?.shadowRoot;
    }
    if (!control || control.disabled || !control.getClientRects().length) throw new Error('Input control is missing, hidden, or disabled');`;
  const evaluate = async (body) => {
    const result = await call('Runtime.evaluate', {
      expression: `(()=>{${resolveControl}${body}})()`,
      returnByValue: true,
    });
    if (result.exceptionDetails)
      throw new Error(
        result.exceptionDetails.exception?.description ?? result.exceptionDetails.text,
      );
    return result.result?.value;
  };
  try {
    const choiceKind = select
      ? await evaluate(
          `return control.localName==='choice-picker' ? 'dropdown' : control.matches('.choice-grid[data-value]') ? 'chips' : null;`,
        )
      : null;
    if (choiceKind) {
      if (choiceKind === 'dropdown') {
        const expanded = await evaluate(
          `return control.shadowRoot.querySelector('.trigger').getAttribute('aria-expanded')==='true';`,
        );
        if (!expanded) await clickInTab(hash, `${selector} >>> .trigger`);
        await inputInTab(hash, `${selector} >>> input`, '', false);
      }
      const escaped = await evaluate(`return CSS.escape(${JSON.stringify(value)});`);
      await clickInTab(
        hash,
        `${selector}${choiceKind === 'chips' ? ' ' : ' >>> '}[data-choice-value="${escaped}"]`,
      );
      if (
        !(await evaluate(
          `return (control.dataset.value ?? control.value)===${JSON.stringify(value)};`,
        ))
      )
        throw new Error('Browser choice did not produce the requested value');
      return { selected: true };
    }
    await call('Page.bringToFront');
    const target = await evaluate(`
      control.scrollIntoView({block:'center'});
      // A new select action must not append to the previous keyboard-search prefix.
      if (${select}) control.blur();
      control.focus();
      if (${select}) {
        if (!(control instanceof HTMLSelectElement) || control.multiple) throw new Error('Expected a single native select');
        const index=Array.from(control.options).findIndex(option=>option.value===${JSON.stringify(value)} && !option.disabled);
        if(index<0) throw new Error('Requested option unavailable');
        return control.options[index].label;
      }
      if (!(control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement) || control.readOnly) throw new Error('Expected an editable text control');
      return -1;`);
    if (select) {
      // Native selects implement incremental keyboard search through character events.
      for (const character of target) {
        await call('Input.dispatchKeyEvent', {
          type: 'char',
          text: character,
          unmodifiedText: character,
        });
      }
    } else {
      await call('Input.dispatchKeyEvent', {
        type: 'rawKeyDown',
        key: 'a',
        code: 'KeyA',
        windowsVirtualKeyCode: 65,
        commands: ['selectAll'],
      });
      await call('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'a',
        code: 'KeyA',
        windowsVirtualKeyCode: 65,
      });
      await call('Input.insertText', { text: value });
    }
    await sleep(100);
    const matches = await evaluate(`return control.value===${JSON.stringify(value)};`);
    if (!matches) throw new Error('Browser input did not produce the requested value');
    return select ? { selected: true } : { filled: true };
  } finally {
    close();
  }
}

async function loginInTab(hash) {
  const secret = GATEWAY_CREDENTIAL?.token ?? GATEWAY_CREDENTIAL?.password;
  const mode = GATEWAY_CREDENTIAL?.token ? 'token' : 'password';
  if (!secret) die('login requires an explicit FARMSLOT_GATEWAY_PROFILE', 2);
  const form = await evalInTab(
    hash,
    `const deadline=Date.now()+5000;
     while(!document.querySelector('.auth-card,#connection-form') && Date.now()<deadline)
       await new Promise(resolve=>setTimeout(resolve,50));
     return document.querySelector('#connection-form') ? 'desktop' : 'browser';`,
  );
  if (form === 'desktop') {
    await inputInTab(hash, '#auth-mode', mode, true);
    await inputInTab(hash, '#secret', secret);
    await clickInTab(hash, '#connection-form button[type=submit]');
  } else {
    await clickInTab(hash, `.auth-mode:nth-child(${mode === 'token' ? 1 : 2})`);
    await inputInTab(hash, '.auth-input', secret);
    await clickInTab(hash, '.auth-card button[type=submit]');
  }
  return evalInTab(
    hash,
    `const deadline=Date.now()+5000;
     while(document.querySelector('farm-app')?.connection!=='connected' && Date.now()<deadline)
       await new Promise(resolve=>setTimeout(resolve,50));
     return {authenticated:document.querySelector('farm-app')?.connection==='connected'};`,
  );
}

async function gatewayRpc(method, paramsJson) {
  const params = paramsJson ? JSON.parse(paramsJson) : {};
  const ws = new WebSocket(GATEWAY_URL);
  return new Promise((resolve, reject) => {
    // Long-running methods (slot.prepare) need more than the default; override
    // per call with FARMSLOT_RPC_TIMEOUT_MS. Only positive integers count —
    // anything else falls back to the default instead of a broken timer.
    const rawTimeout = Number(process.env.FARMSLOT_RPC_TIMEOUT_MS);
    const rpcTimeoutMs = Number.isInteger(rawTimeout) && rawTimeout > 0 ? rawTimeout : 5000;
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`gateway RPC timeout after ${rpcTimeoutMs}ms`));
    }, rpcTimeoutMs);
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

try {
  if (cmd === 'tabs') {
    console.log(JSON.stringify(await listTabs(), null, 2));
  } else if (cmd === 'goto') {
    const [target, flag] = rest;
    if (!target) die('usage: cdp.mjs goto <hash|url> [--new]');
    const result = await navigateTab(target, flag === '--new');
    console.log(JSON.stringify(result, null, 2));
  } else if (cmd === 'eval') {
    const [hash, flag, ...tail] = rest;
    if (!hash) die('usage: cdp.mjs eval <hash|-|<route#hash>> <expr | --file path> [--out file]');
    let expr;
    let outPath;
    const outAt = tail.indexOf('--out');
    if (outAt !== -1) {
      outPath = tail[outAt + 1];
      if (!outPath) die('--out needs a file path');
      tail.splice(outAt, 2);
    }
    if (flag === '--file') expr = readFileSync(tail[0], 'utf8');
    else expr = [flag, ...tail].join(' ');
    if (!expr) die('missing expression');
    const value = await evalInTab(hash, expr);
    const rendered = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    console.log(rendered);
    // `--out` persists a probe result as committed evidence alongside the
    // scenario reports, so a browser-only proof does not live in scrollback.
    if (outPath) {
      writeFileSync(outPath, `${rendered}\n`);
      console.error(`[cdp] wrote ${outPath}`);
    }
  } else if (cmd === 'close') {
    const [hash] = rest;
    if (!hash || hash === '-') die('usage: cdp.mjs close <hash>');
    const tab = await findTab(hash);
    if (!tab) die(`no CDP tab matching hash=${hash}`, 2);
    const response = await fetch(
      `http://${CDP_HOST}:${CDP_PORT}/json/close/${encodeURIComponent(tab.id)}`,
    );
    if (!response.ok) die(`CDP could not close tab (status ${response.status})`, 2);
    console.log(JSON.stringify({ closed: tab.id }));
  } else if (cmd === 'focus') {
    const [hash] = rest;
    if (!hash) die('usage: cdp.mjs focus <hash|-|route>');
    console.log(JSON.stringify(await focusTab(hash), null, 2));
  } else if (cmd === 'key') {
    const [hash, key] = rest;
    if (!hash || !key) die('usage: cdp.mjs key <hash> <1-9|Enter|Escape|Tab>');
    console.log(JSON.stringify(await keyInTab(hash, key)));
  } else if (cmd === 'login') {
    const [hash] = rest;
    if (!hash) die('usage: cdp.mjs login <hash>');
    const result = await loginInTab(hash);
    console.log(JSON.stringify(result, null, 2));
  } else if (cmd === 'click') {
    const [hash, selector, dialogFlag, expectedDialog] = rest;
    if (!hash || !selector) die('usage: cdp.mjs click <hash> <selector>');
    const dialogChoice =
      dialogFlag === '--accept-dialog'
        ? 'accept'
        : dialogFlag === '--dismiss-dialog'
          ? 'dismiss'
          : undefined;
    const observe = dialogFlag === '--observe-file';
    if (dialogFlag && ((!dialogChoice && !observe) || expectedDialog === undefined))
      die('click dialog option requires an exact expected message');
    const observationSource = observe ? readFileSync(resolve(expectedDialog), 'utf8') : undefined;
    console.log(
      JSON.stringify(
        await clickInTab(hash, selector, dialogChoice, expectedDialog, observationSource),
        null,
        2,
      ),
    );
  } else if (cmd === 'fill' || cmd === 'select') {
    const [hash, selector, value] = rest;
    if (!hash || !selector || value === undefined)
      die(`usage: cdp.mjs ${cmd} <hash> <selector> <value>`);
    console.log(JSON.stringify(await inputInTab(hash, selector, value, cmd === 'select'), null, 2));
  } else if (cmd === 'viewport') {
    const [hash, width, height] = rest;
    if (!hash || width === undefined || height === undefined)
      die('usage: cdp.mjs viewport <hash> <width> <height>');
    console.log(JSON.stringify(await viewportTab(hash, Number(width), Number(height)), null, 2));
  } else if (cmd === 'screenshot') {
    const [hash, outputPath, ...flags] = rest;
    if (!hash || !outputPath)
      die(
        'usage: cdp.mjs screenshot <hash|-|route> <output.png> [--appearance dark|light] [--width N --height N]',
      );
    const options = {};
    for (let i = 0; i < flags.length; i += 2) {
      const flag = flags[i];
      const value = flags[i + 1];
      if (!['--appearance', '--width', '--height'].includes(flag) || !value)
        die('Invalid screenshot option');
      options[flag.slice(2)] = flag === '--appearance' ? value : Number(value);
    }
    const result = await screenshotTab(hash, outputPath, options);
    console.log(JSON.stringify(result, null, 2));
  } else if (cmd === 'idle-reads') {
    const [hash, duration, methodsJson] = rest;
    if (!hash || !duration || !methodsJson)
      die('usage: cdp.mjs idle-reads <hash> <ms> <methodsJson>');
    const tab = await findTab(hash);
    if (!tab) die(`no CDP tab matching hash=${hash}`, 2);
    console.log(
      JSON.stringify(
        await observeIdleGatewayReads({
          connect,
          tab,
          durationMs: Number(duration),
          methods: JSON.parse(methodsJson),
        }),
        null,
        2,
      ),
    );
  } else if (cmd === 'baseline') {
    const [hash, phase, route, matchJson] = rest;
    if (!hash || !phase) die('usage: cdp.mjs baseline <hash> <cold|reconnect|diff> [gate-route]');
    const tab = await findTab(hash);
    if (!tab) die(`no CDP tab matching hash=${hash}`, 2);
    console.log(
      JSON.stringify(
        await measureOfflineClientStore({
          connect,
          tab,
          phase,
          route,
          gatewayUrl: process.env.FARMSLOT_GATEWAY,
          match: matchJson ? JSON.parse(matchJson) : undefined,
        }),
        null,
        2,
      ),
    );
  } else if (cmd === 'gateway') {
    const [method, paramsJson] = rest;
    if (!method) die('usage: cdp.mjs gateway <method> [paramsJson]');
    const result = await gatewayRpc(method, paramsJson);
    console.log(JSON.stringify(result, null, 2));
  } else {
    die(
      'usage: cdp.mjs <tabs | goto | eval | close | focus | login | click | fill | select | viewport | screenshot | gateway> ...',
    );
  }
} catch (err) {
  die(`cdp.mjs: ${err.message}`, 2);
}
