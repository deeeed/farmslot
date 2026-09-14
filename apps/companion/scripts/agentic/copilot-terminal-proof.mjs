#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const statePath = process.env.NATIVE_COMPANION_TERMINAL_STATE;
assert(statePath && process.env.NATIVE_COMPANION_TOKEN_FILE);
process.env.FARMSLOT_GATEWAY = 'ws://127.0.0.1:18777';
process.env.FARMSLOT_GATEWAY_TOKEN = fs
  .readFileSync(process.env.NATIVE_COMPANION_TOKEN_FILE, 'utf8')
  .trim();
const { rpc } = await import(
  path.join(root, 'scripts/runner-validation/scenarios/native-worker-lifecycle.mjs')
);
const phase = process.argv[2];
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
if (phase === 'open') {
  const current = rpc('copilot.status').session;
  assert.equal(current.status, 'running');
  assert.deepEqual(current.terminalWorker, state.worker);
  execFileSync('xcrun', [
    'simctl',
    'openurl',
    process.env.IOS_SIMULATOR,
    `farmslot-development:///copilot?draft=${encodeURIComponent(state.draft)}`,
  ]);
} else if (phase === 'verify') {
  const expr =
    'const s=Array.from(__r.getModules().values()).find(x=>x.verboseName?.endsWith("global-state/router-store.js")).publicModule.exports.store; return s.getRouteInfo();';
  const route = JSON.parse(
    execFileSync(
      process.execPath,
      [path.join(root, 'apps/companion/scripts/agentic/cdp-eval.mjs'), expr],
      {
        env: {
          ...process.env,
          METRO_PORT: '18782',
          FARMSLOT_METRO_ORIGIN: 'http://localhost:18782',
        },
        encoding: 'utf8',
        timeout: 30000,
      },
    ),
  );
  assert.equal(route.pathname, '/terminal/worker');
  const worker = JSON.parse(route.params.workerRef);
  assert.deepEqual(worker, state.worker);
  assert.equal(route.params.draft, state.draft);
  const current = rpc('copilot.status').session;
  assert.deepEqual(current.terminalWorker, state.worker);
  assert.deepEqual(
    current.lastDelivery,
    state.lastDelivery,
    'Opening a terminal must not send the draft',
  );
  fs.writeFileSync(
    `${statePath}.evidence.json`,
    JSON.stringify(
      {
        route,
        worker,
        current: {
          runtimeId: current.runtimeId,
          status: current.status,
          lastDelivery: current.lastDelivery,
        },
      },
      null,
      2,
    ) + '\n',
  );
} else throw Error(`Unknown phase ${phase}`);
console.log(JSON.stringify({ phase, pass: true, worker: state.worker }));
