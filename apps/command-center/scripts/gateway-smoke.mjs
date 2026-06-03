#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const args = parseArgs(process.argv.slice(2));
const method = requiredArg(args, 'method');
const gatewayUrl = args['gateway-url'] ?? process.env.FARMSLOT_GATEWAY ?? 'ws://localhost:7777';
const runId = args['run-id'];
const slotId = args['slot-id'];

const reportsDir = path.resolve(process.cwd(), 'reports');
const logsDir = path.resolve(process.cwd(), 'logs');
await mkdir(reportsDir, { recursive: true });
await mkdir(logsDir, { recursive: true });

const transcript = {
  method,
  gatewayUrl,
  params: {
    ...(runId ? { runId } : {}),
    ...(slotId ? { slotId } : {}),
  },
  startedAt: new Date().toISOString(),
  response: await callGateway(method, {
    ...(runId ? { runId } : {}),
    ...(slotId ? { slotId } : {}),
  }),
};

await writeFile(
  path.join(reportsDir, 'gateway-rpc.json'),
  `${JSON.stringify(transcript, null, 2)}\n`,
  'utf-8',
);
await writeFile(
  path.join(logsDir, 'gateway-rpc.log'),
  [
    `method=${method}`,
    `gatewayUrl=${gatewayUrl}`,
    `runId=${runId ?? ''}`,
    `slotId=${slotId ?? ''}`,
    `ok=true`,
  ].join('\n') + '\n',
  'utf-8',
);

console.log(JSON.stringify(transcript.response, null, 2));

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith('--')) throw new Error(`Unexpected positional argument: ${value}`);
    const key = value.slice(2);
    const next = values[index + 1];
    if (!next || next.startsWith('--')) throw new Error(`Missing value for --${key}`);
    parsed[key] = next;
    index += 1;
  }
  return parsed;
}

function requiredArg(args, key) {
  const value = args[key];
  if (!value) throw new Error(`Missing --${key}.`);
  return value;
}

async function callGateway(rpcMethod, params) {
  const url = normalizeWebSocketUrl(gatewayUrl);
  const ws = new WebSocket(url);
  const authPayload = gatewayCredential();
  await waitForOpen(ws);
  await request(ws, 'auth-1', 'auth.connect', {
    clientKind: 'ui',
    clientName: 'farmslot-gateway-smoke',
    ...authPayload,
  });
  return request(ws, 'rpc-1', rpcMethod, params).finally(() => ws.close());
}

function normalizeWebSocketUrl(url) {
  if (url.startsWith('ws://') || url.startsWith('wss://')) return url;
  if (url.startsWith('http://')) return `ws://${url.slice('http://'.length)}`;
  if (url.startsWith('https://')) return `wss://${url.slice('https://'.length)}`;
  throw new Error(`Gateway URL must be ws(s):// or http(s)://, received: ${url}`);
}

function gatewayCredential() {
  if (process.env.FARMSLOT_GATEWAY_TOKEN) return { token: process.env.FARMSLOT_GATEWAY_TOKEN };
  if (process.env.FARMSLOT_GATEWAY_PASSWORD) {
    return { password: process.env.FARMSLOT_GATEWAY_PASSWORD };
  }
  return {};
}

function waitForOpen(ws) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('gateway connection timeout')), 5000);
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('gateway connection error'));
    });
  });
}

function request(ws, id, rpcMethod, params) {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`gateway RPC timeout for ${rpcMethod}`));
    }, 5000);

    const onMessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== id) return;
      clearTimeout(timer);
      ws.removeEventListener('message', onMessage);
      if (message.ok) {
        resolvePromise(message.payload ?? message.result);
      } else {
        reject(new Error(JSON.stringify(message.error ?? message)));
      }
    };

    ws.addEventListener('message', onMessage);
    ws.send(JSON.stringify({ type: 'req', id, method: rpcMethod, params }));
  });
}
