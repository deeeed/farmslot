#!/usr/bin/env node
// Evaluate JS in the connected Android/iOS companion via Metro inspector CDP.
//
// Usage:
//   node scripts/agentic/cdp-eval.mjs '<expression>'
//   node scripts/agentic/cdp-eval.mjs --file probes/example.js
//
// Env:
//   METRO_PORT (default 7677)
//   FARMSLOT_METRO_ORIGIN (optional; auto-detects loopback + LAN when unset)

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import WebSocket from 'ws';

const metroPort = process.env.METRO_PORT ?? '7677';

function detectLanHost() {
  if (process.env.REACT_NATIVE_PACKAGER_HOSTNAME?.trim()) {
    return process.env.REACT_NATIVE_PACKAGER_HOSTNAME.trim();
  }
  try {
    const iface = execSync('route get default 2>/dev/null | awk \'/interface:/{print $2; exit}\'', {
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
  const candidates = [
    `http://127.0.0.1:${metroPort}`,
    `http://localhost:${metroPort}`,
  ];
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
  const res = await fetch(`http://127.0.0.1:${metroPort}/json/list`);
  if (!res.ok) throw new Error(`Metro CDP list failed: HTTP ${res.status}`);
  return res.json();
}

function unwrapHermesValue(raw) {
  if (raw && typeof raw === 'object' && raw._z && typeof raw._z === 'object') {
    return raw._z;
  }
  return raw;
}

async function evalInTarget(target, expression, metroOrigin) {
  const ws = new WebSocket(target.webSocketDebuggerUrl, {
    headers: { Origin: metroOrigin },
  });
  const pending = new Map();
  let nextId = 0;

  ws.on('message', (buf) => {
    const msg = JSON.parse(String(buf));
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message ?? JSON.stringify(msg.error))) : resolve(msg.result);
    }
  });

  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });

  try {
    await call('Runtime.enable');
    const trimmed = expression.trim();
    const useStatementForm =
      trimmed.includes('\n') ||
      /\b(const|let|var|return|await|require\()\b/.test(trimmed);
    const wrapped = useStatementForm
      ? `(async () => { ${trimmed} })()`
      : `(async () => (${trimmed}))()`;
    let result = await call('Runtime.evaluate', {
      expression: wrapped,
      awaitPromise: true,
      returnByValue: true,
    });
    const exceptionText = [
      result.exceptionDetails?.text ?? '',
      result.exceptionDetails?.exception?.description ?? '',
    ].join(' ');
    if (result.exceptionDetails && /SyntaxError/.test(exceptionText) && !useStatementForm) {
      result = await call('Runtime.evaluate', {
        expression: `(async () => { ${trimmed} })()`,
        awaitPromise: true,
        returnByValue: true,
      });
    }
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ??
          result.exceptionDetails.text ??
          'Runtime.evaluate failed',
      );
    }
    return unwrapHermesValue(result.result?.value);
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
      lastError = error;
    }
  }
  throw lastError ?? new Error('Metro CDP evaluate failed for all origin candidates.');
}

const targets = await listTargets();
const target =
  targets.find((entry) => entry.appId?.includes('farmslot')) ??
  targets.find((entry) => entry.type === 'node') ??
  targets[0];
if (!target?.webSocketDebuggerUrl) {
  console.error(
    `No React Native CDP target on Metro :${metroPort}. Launch the dev client and wait for /json/list.`,
  );
  process.exit(2);
}

const value = await evalWithOriginFallback(target, expr);
console.log(JSON.stringify(value, null, 2));
