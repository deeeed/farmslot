#!/usr/bin/env node
// Evaluate JS in the connected Android/iOS companion via Metro inspector CDP.
//
// Usage:
//   node scripts/agentic/cdp-eval.mjs '<expression>'
//   node scripts/agentic/cdp-eval.mjs --file probes/example.js
//
// Env:
//   METRO_PORT (required; supplied by slot/worktree configuration)
//   FARMSLOT_METRO_ORIGIN (optional; auto-detects loopback + LAN when unset)
//   FARMSLOT_CDP_TARGET_ID (optional; select a specific connected device from /json/list)

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import WebSocket from 'ws';

const metroPort = process.env.METRO_PORT;
if (!/^[1-9]\d*$/.test(metroPort ?? '')) {
  throw new Error('METRO_PORT must come from the Farmslot slot/worktree port configuration.');
}

function detectLanHost() {
  if (process.env.REACT_NATIVE_PACKAGER_HOSTNAME?.trim()) {
    return process.env.REACT_NATIVE_PACKAGER_HOSTNAME.trim();
  }
  try {
    const iface = execSync("route get default 2>/dev/null | awk '/interface:/{print $2; exit}'", {
      encoding: 'utf8',
    }).trim();
    if (iface) {
      const ip = execSync(`ipconfig getifaddr ${iface} 2>/dev/null`, { encoding: 'utf8' }).trim();
      if (ip) return ip;
    }
  } catch {
    // fall through
  }
  try {
    const ip = execSync('ipconfig getifaddr en0 2>/dev/null', { encoding: 'utf8' }).trim();
    if (ip) return ip;
  } catch {
    // fall through
  }
  return null;
}

function metroOriginCandidates() {
  if (process.env.FARMSLOT_METRO_ORIGIN?.trim()) {
    return [process.env.FARMSLOT_METRO_ORIGIN.trim()];
  }
  const candidates = [`http://127.0.0.1:${metroPort}`, `http://localhost:${metroPort}`];
  const lanHost = detectLanHost();
  if (lanHost) candidates.push(`http://${lanHost}:${metroPort}`);
  return [...new Set(candidates)];
}

const [, , ...rest] = process.argv;
let expr = rest.join(' ').trim();
if (rest[0] === '--file') {
  expr = readFileSync(rest[1], 'utf8');
}
if (!expr) {
  console.error('Usage: node scripts/agentic/cdp-eval.mjs <expr>|--file <path>');
  process.exit(1);
}

async function listTargets() {
  const origin = process.env.FARMSLOT_METRO_ORIGIN?.trim() || `http://127.0.0.1:${metroPort}`;
  const res = await fetch(`${origin.replace(/\/$/, '')}/json/list`);
  if (!res.ok) throw new Error(`Metro CDP list failed: HTTP ${res.status}`);
  return res.json();
}

async function evalInTarget(target, expression, metroOrigin) {
  const ws = new WebSocket(target.webSocketDebuggerUrl, {
    headers: { Origin: metroOrigin },
    handshakeTimeout: 30000,
  });
  const pending = new Map();
  const deadline = Date.now() + 30000;
  let nextId = 0;
  let evaluationStarted = false;
  const failPending = (error) => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  };
  ws.on('error', failPending);
  ws.on('close', (code, reason) => failPending(new Error(`Metro CDP closed (${code}): ${reason}`)));
  ws.on('message', (buf) => {
    const msg = JSON.parse(String(buf));
    const entry = pending.get(msg.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(msg.id);
    if (msg.error) entry.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
    else entry.resolve(msg.result);
  });
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(
        () => {
          pending.delete(id);
          reject(new Error(`Metro CDP ${method} timed out`));
        },
        Math.max(1, deadline - Date.now()),
      );
      pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const assertResult = (result) => {
    if (result.exceptionDetails)
      throw new Error(
        result.exceptionDetails.exception?.description ??
          result.exceptionDetails.text ??
          'Runtime evaluation failed',
      );
  };
  try {
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    await call('Runtime.enable');
    const trimmed = expression.trim();
    const statement =
      trimmed.includes('\n') || /\b(const|let|var|return|await|require\()\b/.test(trimmed);
    // Hermes can return an unsettled polyfill Promise despite awaitPromise:true.
    // Retain an ordinary observer object and read its settlement over CDP instead.
    // This object is debugger-owned; it never writes UI or application store state.
    const wrap = (body) => `(() => {
      const observation = { done: false };
      (${body}).then(
        value => { observation.value = value; observation.done = true; },
        error => { observation.error = String(error?.stack ?? error); observation.done = true; }
      );
      return observation;
    })()`;
    evaluationStarted = true;
    let result = await call('Runtime.evaluate', {
      expression: wrap(
        statement ? `(async () => { ${trimmed} })()` : `(async () => (${trimmed}))()`,
      ),
      returnByValue: false,
    });
    const exception = `${result.exceptionDetails?.text ?? ''} ${result.exceptionDetails?.exception?.description ?? ''}`;
    if (result.exceptionDetails && /SyntaxError/.test(exception) && !statement) {
      result = await call('Runtime.evaluate', {
        expression: wrap(`(async () => { ${trimmed} })()`),
        returnByValue: false,
      });
    }
    assertResult(result);
    const objectId = result.result?.objectId;
    if (!objectId) throw new Error('Metro CDP did not retain the evaluation observer');
    for (;;) {
      const observed = await call('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: 'function() { return this; }',
        returnByValue: true,
      });
      assertResult(observed);
      const state = observed.result?.value;
      if (state?.done) {
        if (Object.hasOwn(state, 'error')) throw new Error(state.error);
        return state.value;
      }
      if (Date.now() >= deadline) throw new Error('Metro CDP expression timed out');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  } catch (error) {
    // Changing Origin after evaluation began could execute a side effect twice.
    if (evaluationStarted) error.evaluationStarted = true;
    throw error;
  } finally {
    ws.close();
  }
}

async function evalWithOriginFallback(target, expression) {
  let lastError = null;
  for (const origin of metroOriginCandidates()) {
    try {
      return await evalInTarget(target, expression, origin);
    } catch (error) {
      if (error.evaluationStarted) throw error;
      lastError = error;
    }
  }
  throw lastError ?? new Error('Metro CDP evaluate failed for all origin candidates.');
}

const targets = await listTargets();
const target = process.env.FARMSLOT_CDP_TARGET_ID
  ? targets.find((entry) => entry.id === process.env.FARMSLOT_CDP_TARGET_ID)
  : (targets.find((entry) => entry.appId?.includes('farmslot')) ??
    targets.find((entry) => entry.type === 'node') ??
    targets[0]);
if (!target?.webSocketDebuggerUrl) {
  console.error(
    `No React Native CDP target on Metro :${metroPort}. Launch the dev client and wait for /json/list.`,
  );
  process.exit(2);
}

const value = await evalWithOriginFallback(target, expr);
console.log(JSON.stringify(value, null, 2));
