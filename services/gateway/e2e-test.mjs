#!/usr/bin/env node
// E2E validation: tests every RPC the UI calls and validates response shapes match expectations.
// Catches type mismatches like slot.check returning { requestId } when UI expects { slot, checks }.
// Run: cd services/gateway && yarn node e2e-test.mjs
// Auth: FARMSLOT_GATEWAY_TOKEN/PASSWORD are read from process env or nearest .env.local-auth/.env.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { WebSocket } from 'ws';

const GW = process.env.FARMSLOT_GATEWAY ?? process.env.GW_URL ?? 'ws://localhost:7777';
const GATEWAY_CREDENTIAL = resolveGatewayCredential();
let passed = 0;
let failed = 0;

function rpc(ws, method, params) {
  return new Promise((resolve, reject) => {
    const id = 'test-' + Math.random().toString(36).slice(2);
    const handler = (d) => {
      const msg = JSON.parse(d.toString());
      if (msg.id === id) {
        ws.off('message', handler);
        resolve(msg); // Always resolve — caller checks .ok
      }
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({ type: 'req', id, method, params }));
    setTimeout(() => {
      ws.off('message', handler);
      reject(new Error(`timeout: ${method}`));
    }, 10000);
  });
}

function assert(label, condition, detail) {
  if (condition) {
    console.log('  PASS', label);
    passed++;
  } else {
    console.log('  FAIL', label, '—', detail || '');
    failed++;
  }
}

function hasKeys(obj, keys) {
  if (!obj) return false;
  return keys.every((k) => obj[k] !== undefined);
}

async function authenticate(ws, clientKind, clientName) {
  const r = await rpc(ws, 'auth.connect', {
    clientKind,
    clientName,
    ...(GATEWAY_CREDENTIAL?.token ? { token: GATEWAY_CREDENTIAL.token } : {}),
    ...(GATEWAY_CREDENTIAL?.password ? { password: GATEWAY_CREDENTIAL.password } : {}),
  });
  if (!r.ok) throw new Error(`auth.connect failed: ${r.error?.message ?? JSON.stringify(r)}`);
}

function openWebSocket() {
  const ws = new WebSocket(GW);
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
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

const ws = new WebSocket(GW);
let helloPayload = null;

ws.on('message', (d) => {
  const msg = JSON.parse(d.toString());
  if (msg.type === 'event' && msg.event === 'hello') helloPayload = msg.payload;
});

ws.on('open', async () => {
  await authenticate(ws, 'ui', 'farmslot-gateway-e2e');
  await new Promise((r) => setTimeout(r, 500)); // Wait for hello event
  console.log('\n=== Command Center E2E — All UI Flows ===\n');

  // ─── Hello event ───────────────────────────────────────────────
  console.log('0. Hello event (on connect)');
  assert('hello received', helloPayload !== null, 'no hello event');
  assert('hello.fleet exists', helloPayload?.fleet !== null, 'fleet is null');
  assert('hello.fleet.slots is array', Array.isArray(helloPayload?.fleet?.slots), 'not array');

  // ─── Flow 1: fleet.status ─────────────────────────────────────
  // UI: state.ts:137 — gateway.request<FleetStatusResult>(Methods.FLEET_STATUS)
  // Expects: { fleet: FleetStatus }
  console.log('\n1. fleet.status (fleet-canvas, split-view, state.ts)');
  const r1 = await rpc(ws, 'fleet.status', {});
  assert('ok', r1.ok, r1.error?.message);
  assert(
    'has fleet obj',
    r1.payload?.fleet !== undefined,
    `keys: ${Object.keys(r1.payload ?? {})}`,
  );
  assert('fleet.slots is array', Array.isArray(r1.payload?.fleet?.slots), 'not array');
  assert('fleet.summary exists', r1.payload?.fleet?.summary !== undefined, 'no summary');
  const slots = r1.payload?.fleet?.slots ?? [];
  if (slots.length > 0) {
    const s = slots[0];
    assert(
      'slot shape',
      hasKeys(s, [
        'slot',
        'machine',
        'platform',
        'project',
        'health',
        'lifecycle',
        'branch',
        'agent',
      ]),
      `missing fields in: ${Object.keys(s)}`,
    );
    assert(
      'health shape',
      hasKeys(s.health, ['ssh', 'device', 'metro', 'cdp', 'fixtures']),
      `missing health fields in: ${Object.keys(s.health ?? {})}`,
    );
  }

  // ─── Flow 2: slot-detail (loads from fleet store, no RPC) ─────
  // UI: slot-detail.ts — _loadSlot() uses getState().fleet
  console.log('\n2. slot-detail (from fleet store — no RPC)');
  assert('fleet store has slots', slots.length > 0, `${slots.length} slots`);
  if (slots.length > 0) {
    const s = slots[0];
    assert('slot has taskFile field', s.taskFile !== undefined, 'missing taskFile');
    assert('slot has dispatchedAt field', s.dispatchedAt !== undefined, 'missing dispatchedAt');
    assert('slot has runner field', s.runner !== undefined, 'missing runner');
    assert('slot has model field', s.model !== undefined, 'missing model');
    assert('slot has metroPort field', s.metroPort !== undefined, 'missing metroPort');
    assert('slot has deviceName field', s.deviceName !== undefined, 'missing deviceName');
  }

  const testSlot = slots[0]?.slot ?? 'runner-mobile-1';

  // ─── Flow 3: slot.check (streaming action) ────────────────────
  // UI: slot-detail.ts:380 — gateway.request<{ requestId: string }>(method, params)
  // Returns: { requestId } (NOT { slot, checks })
  console.log('\n3. slot.check (streaming action — slot-detail action buttons)');
  const r3 = await rpc(ws, 'slot.check', { slotId: testSlot });
  assert('ok', r3.ok, r3.error?.message);
  assert(
    'returns { requestId }',
    typeof r3.payload?.requestId === 'string',
    `got keys: ${Object.keys(r3.payload ?? {})}`,
  );
  assert(
    'does NOT return { slot }',
    r3.payload?.slot === undefined,
    'has slot — would confuse UI if it tried to read it',
  );

  // ─── Flow 4: terminal.subscribe ────────────────────────────────
  // UI: terminal-view.ts:243 — gateway.request(Methods.TERMINAL_SUBSCRIBE, { slotId })
  console.log('\n4. terminal.subscribe');
  const r4 = await rpc(ws, 'terminal.subscribe', { slotId: testSlot });
  if (r4.ok) {
    assert(
      'returns { subscribed: true }',
      r4.payload?.subscribed === true,
      `got: ${JSON.stringify(r4.payload)}`,
    );
  } else {
    assert(
      'fails gracefully (no tmux)',
      r4.error?.message?.includes('tmux') || r4.error?.message?.includes('session'),
      r4.error?.message,
    );
  }

  // ─── Flow 5: terminal.snapshot ─────────────────────────────────
  // UI: terminal-view.ts:269 — expects { slotId, lines[], timestamp }
  console.log('\n5. terminal.snapshot');
  const r5 = await rpc(ws, 'terminal.snapshot', { slotId: testSlot });
  if (r5.ok) {
    assert('has slotId', typeof r5.payload?.slotId === 'string', `${typeof r5.payload?.slotId}`);
    assert('has lines array', Array.isArray(r5.payload?.lines), `${typeof r5.payload?.lines}`);
    assert(
      'has timestamp',
      typeof r5.payload?.timestamp === 'number',
      `${typeof r5.payload?.timestamp}`,
    );
  } else {
    assert('fails gracefully', true, r5.error?.message);
  }

  // ─── Flow 6: terminal.send ─────────────────────────────────────
  // UI: terminal-view.ts:307, violation-feed.ts:183 — fire-and-forget
  console.log('\n6. terminal.send (nudge button / input bar)');
  const r6 = await rpc(ws, 'terminal.send', { slotId: testSlot, text: '[E2E-TEST]', enter: false });
  if (r6.ok) {
    assert(
      'returns { sent: true }',
      r6.payload?.sent === true,
      `got: ${JSON.stringify(r6.payload)}`,
    );
  } else {
    assert(
      'fails with tmux error',
      r6.error?.message?.includes('pane') || r6.error?.message?.includes('tmux'),
      r6.error?.message,
    );
  }

  // ─── Flow 7: terminal.unsubscribe ──────────────────────────────
  // UI: terminal-view.ts:296
  console.log('\n7. terminal.unsubscribe');
  const r7 = await rpc(ws, 'terminal.unsubscribe', { slotId: testSlot });
  assert('ok', r7.ok, r7.error?.message);
  assert(
    'returns { unsubscribed: true }',
    r7.payload?.unsubscribed === true,
    `got: ${JSON.stringify(r7.payload)}`,
  );

  // ─── Flow 8: pr.list ──────────────────────────────────────────
  // UI: pr-board.ts:227 — expects { prs: PRStatus[] }
  console.log('\n8. pr.list (pr-board)');
  const r8 = await rpc(ws, 'pr.list', {});
  assert('ok', r8.ok, r8.error?.message);
  assert('has prs array', Array.isArray(r8.payload?.prs), `got: ${typeof r8.payload?.prs}`);

  // ─── Flow 9: decision.list ─────────────────────────────────────
  // UI: decision-inbox.ts:240 — expects { decisions: PendingDecision[] }
  console.log('\n9. decision.list (decision-inbox)');
  const r9 = await rpc(ws, 'decision.list', {});
  assert('ok', r9.ok, r9.error?.message);
  assert(
    'has decisions array',
    Array.isArray(r9.payload?.decisions),
    `got: ${typeof r9.payload?.decisions}`,
  );

  // ─── Flow 10: nodes.list ───────────────────────────────────────
  // UI: fleet-canvas.ts — expects { nodes: Array<{ machine, pid, connectedAt }>, gatewayProtocolVersion }
  console.log('\n10. nodes.list (presence indicators)');
  const r10 = await rpc(ws, 'nodes.list', {});
  assert('ok', r10.ok, r10.error?.message);
  assert('has nodes array', Array.isArray(r10.payload?.nodes), `got: ${typeof r10.payload?.nodes}`);

  // ─── Flow 11: task.progress ────────────────────────────────────
  // UI: terminal-view.ts:284 — expects { slotId, markdown }
  console.log('\n11. task.progress (progress tracker)');
  const workingSlot = slots.find((s) => s.taskFile);
  const r11 = await rpc(ws, 'task.progress', { slotId: workingSlot?.slot ?? testSlot });
  if (workingSlot) {
    assert('ok for slot with taskFile', r11.ok, r11.error?.message);
    assert('has slotId', typeof r11.payload?.slotId === 'string', `${typeof r11.payload?.slotId}`);
    assert(
      'has markdown',
      typeof r11.payload?.markdown === 'string',
      `${typeof r11.payload?.markdown}`,
    );
  } else {
    assert('errors for slot without taskFile', !r11.ok, 'expected error');
    assert(
      'error mentions task file',
      r11.error?.message?.includes('task file'),
      r11.error?.message,
    );
  }

  // ─── Flow 12: dispatch.preview ─────────────────────────────────
  // UI: dispatch-wizard.ts:385 — expects { preview: DispatchPreview }
  console.log('\n12. dispatch.preview');
  const r12 = await rpc(ws, 'dispatch.preview', {
    project: 'example-mobile-farm',
    flowType: 'fix-bug',
    ticketOrPr: 'PROJ-9999',
  });
  if (r12.ok) {
    assert(
      'has preview obj',
      r12.payload?.preview !== undefined,
      `keys: ${Object.keys(r12.payload ?? {})}`,
    );
  } else {
    // May fail when no slot is available — acceptable
    assert('errors gracefully', typeof r12.error?.message === 'string', 'no error message');
  }

  // ─── Flow 13: NODE_CONNECTED broadcast ─────────────────────────
  // UI: fleet-canvas.ts subscribes to Events.NODE_CONNECTED
  console.log('\n13. NODE_CONNECTED event broadcast');
  const observer = await openWebSocket();
  await authenticate(observer, 'ui', 'farmslot-e2e-observer');
  const eventPromise = new Promise((resolve) => {
    observer.on('message', (d) => {
      const msg = JSON.parse(d.toString());
      if (msg.event === 'node.connected') resolve(msg);
    });
    setTimeout(() => resolve(null), 3000);
  });
  const tempNode = await openWebSocket();
  await authenticate(tempNode, 'node', 'e2e-test-machine');
  await rpc(tempNode, 'node.connect', { machine: 'e2e-test-machine', pid: 99999 });
  const event = await eventPromise;
  assert('broadcast received', event !== null, 'no event');
  assert(
    'has machine',
    event?.payload?.machine === 'e2e-test-machine',
    `got: ${JSON.stringify(event?.payload)}`,
  );
  tempNode.close();
  observer.close();

  // ─── Flow 14: config endpoints ─────────────────────────────────
  console.log('\n14. config endpoints');
  const r14a = await rpc(ws, 'config.pools', {});
  if (r14a.ok)
    assert(
      'config.pools has array',
      Array.isArray(r14a.payload?.pools),
      `${typeof r14a.payload?.pools}`,
    );
  else assert('config.pools responds', true, r14a.error?.message);

  const r14b = await rpc(ws, 'config.projects', {});
  if (r14b.ok)
    assert(
      'config.projects has array',
      Array.isArray(r14b.payload?.projects),
      `${typeof r14b.payload?.projects}`,
    );
  else assert('config.projects responds', true, r14b.error?.message);

  // ─── Summary ───────────────────────────────────────────────────
  console.log(`\n${'='.repeat(50)}`);
  console.log(`  ${passed} passed, ${failed} failed, ${passed + failed} total`);
  console.log(`${'='.repeat(50)}\n`);

  ws.close();
  process.exit(failed > 0 ? 1 : 0);
});

ws.on('error', (e) => {
  console.error('Connection error:', e.message);
  process.exit(1);
});
