// Run through run-list-version-fill.recipe.json, or the D12 native boot, on an isolated, paired
// dev client against a gateway with version lists. Each phase prints one JSON receipt line.
// Only `reset-store` touches the app process; the boot's controller owns launches and the gateway,
// so the others never launch, terminate or stop anything. `--trigger=false` verifies only.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';

import { catchUpHolds, offlineTotalsHold, pageReport } from './run-list-version-fill-checks.mjs';

const PHASES = ['reset-store', 'cold-fill', 'catch-up', 'offline-totals', 'recover-catch-up'];
const HISTORY_RUN_LIST_LIMIT = 80;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    trigger: { type: 'string', default: 'true' },
    since: { type: 'string' },
    count: { type: 'string' },
    changed: { type: 'string' },
    'min-runs': { type: 'string', default: String(HISTORY_RUN_LIST_LIMIT + 1) },
    'expect-total': { type: 'string' },
    'expect-oversized': { type: 'boolean', default: false },
  },
});
const [phase] = positionals;
assert(PHASES.includes(phase), `Expected one of ${PHASES.join(', ')}`);
const trigger = values.trigger !== 'false';
const minRuns = Number(values['min-runs']);
const metro = process.env.METRO_PORT;
assert(/^\d+$/.test(metro ?? ''), 'Select the isolated METRO_PORT');
const appId = process.env.FARMSLOT_RECIPE_APP_ID ?? 'net.siteed.farmslot.development';
const checkpoints = process.env.FARMSLOT_D12_CHECKPOINTS;
const caseName = process.env.FARMSLOT_D12_CASE ?? 'run-list-version-fill';

async function observe(ref = 'run-list-version-fill') {
  const response = await fetch(`http://127.0.0.1:${metro}/farmslot-recipe/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      command: 'observeUi',
      nodeId: 'run-list-version-fill',
      payload: { refs: [ref] },
      timeout_ms: 3000,
    }),
    signal: AbortSignal.timeout(5000),
  }).catch(() => undefined);
  // No app is polling the relay while its native process starts.
  if (!response || response.status === 504) return undefined;
  assert(response.ok, `Recipe relay failed with HTTP ${response.status}`);
  const result = await response.json();
  assert(result.ok, result.error ?? 'Recipe observer failed');
  return result.observations?.runListVersionFill;
}

/** Polls the app until `done` holds; the deadline covers a whole fill, not one page. */
async function until(done, label, ref, timeoutMs = 180_000) {
  const end = Date.now() + timeoutMs;
  let state;
  while (Date.now() < end) {
    state = await observe(ref);
    ref = undefined;
    if (state && done(state)) return state;
    await delay(200);
  }
  throw new Error(`${label}: ${JSON.stringify(state ? { ...state, frames: undefined } : null)}`);
}

let serial = 0;
/** D11 protocol: one controller action per request file, acknowledged by its -ack.json. */
async function checkpoint(action, args = {}) {
  assert(checkpoints, 'FARMSLOT_D12_CHECKPOINTS names the controller directory');
  const existing = readdirSync(checkpoints).filter((name) => name.endsWith('-request.json'));
  serial = Math.max(serial, existing.length);
  const step = `${String(++serial).padStart(2, '0')}-${action}`;
  const request = path.join(checkpoints, `${step}-request.json`);
  await writeFile(`${request}.tmp`, JSON.stringify({ case: caseName, action, args }));
  await rename(`${request}.tmp`, request);
  const end = Date.now() + 180_000;
  while (Date.now() < end) {
    try {
      const ack = JSON.parse(await readFile(path.join(checkpoints, `${step}-ack.json`), 'utf8'));
      assert.equal(ack.action, action);
      return ack;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await delay(100);
  }
  throw new Error(`${step}: no controller acknowledgement`);
}

const settled = (state) =>
  state.pendingRunLists === 0 && state.history?.status === 'ready' && Boolean(state.history);

function print(receipt) {
  console.log(JSON.stringify({ phase, ...receipt }));
  if (!receipt.ok) process.exitCode = 1;
}

if (phase === 'reset-store') {
  // Standalone only: the boot's controller wipes the container before its first launch instead.
  const simulator = process.env.IOS_SIMULATOR;
  assert(simulator, 'Select the isolated IOS_SIMULATOR');
  execFileSync('xcrun', ['simctl', 'terminate', simulator, appId], { stdio: 'pipe' });
  const data = execFileSync('xcrun', ['simctl', 'get_app_container', simulator, appId, 'data'], {
    encoding: 'utf8',
  }).trim();
  // Only the resource store; pairing and the saved login stay.
  await rm(path.join(data, 'Library/Caches/farmslot-resource-store'), {
    recursive: true,
    force: true,
  });
  execFileSync('xcrun', ['simctl', 'launch', simulator, appId], { stdio: 'pipe' });
  print({ ok: true, runListStoreReset: true });
} else if (phase === 'cold-fill') {
  const since = Number(values.since ?? 0);
  await until((state) => state.status === 'connected', 'Companion did not connect');
  const state = await until(
    (next) =>
      settled(next) && next.frames.some((frame) => frame.kind === 'versions' && frame.at >= since),
    'The version-list fill did not settle',
    'run-list-version-fill:open-history',
  );
  const frames = state.frames.filter((frame) => frame.at >= since);
  const report = pageReport(frames);
  // The version reply comes first; a run updating mid-fill may add another, so count them.
  const ordered = frames[0]?.kind === 'versions';
  const whole =
    state.history.rows === state.history.totalCount && state.history.totalCount >= minRuns;
  const ok =
    state.versionLists === true &&
    state.historyLimit === null &&
    report.versionReads >= 1 &&
    report.listReads === 0 &&
    report.pages >= 1 &&
    ordered &&
    report.pagesWithinBounds &&
    (!values['expect-oversized'] || report.oversizedPage) &&
    whole;
  print({
    ok,
    runListColdFill: ok,
    epoch: state.epoch,
    connectionId: state.connectionId,
    historyLimit: state.historyLimit,
    historyRuns: state.history.rows,
    totalCount: state.history.totalCount,
    ...report,
    requestedIds: report.requestedIds.length,
    frames,
  });
} else if (phase === 'catch-up' || phase === 'recover-catch-up') {
  const recover = phase === 'recover-catch-up';
  const count = Number(values.count ?? (recover ? 3 : 5));
  let changed = values.changed?.split(',').filter(Boolean);
  let since = Number(values.since ?? 0);
  // Recovery may start with the gateway already down, after offline-totals.
  const before = await until(
    (state) => recover || state.status === 'connected',
    'Companion is not connected',
  );
  if (trigger && recover) {
    // The gateway is already stopped (offline-totals); its restart is a new epoch.
    changed = (await checkpoint('change-runs', { count, gatewayDown: true })).changedIds ?? changed;
    since = Date.now();
    await checkpoint('gateway-start');
  } else if (trigger) {
    // The proxy holds the reconnect while runs change, so they arrive only through the catch-up.
    await checkpoint('proxy-hold');
    changed = (await checkpoint('change-runs', { count })).changedIds ?? changed;
    since = Date.now();
    await checkpoint('proxy-release');
  }
  const state = await until(
    (next) =>
      next.status === 'connected' &&
      settled(next) &&
      next.history.observedAt >= since &&
      (!trigger ||
        (recover ? next.epoch !== before.epoch : next.connectionId !== before.connectionId)),
    recover ? 'The new epoch did not catch up' : 'The reconnect did not catch up',
    'run-list-version-fill:open-history',
  );
  const frames = state.frames.filter((frame) => frame.at >= since);
  const report = pageReport(frames);
  const ok =
    catchUpHolds(report, changed, count) &&
    state.history.rows === state.history.totalCount &&
    (!recover || !trigger || state.epoch !== before.epoch);
  print({
    ok,
    [recover ? 'runListRecoverCatchUp' : 'runListCatchUp']: ok,
    epoch: state.epoch,
    connectionId: state.connectionId,
    changedIds: changed ?? null,
    count,
    ...report,
    frames,
  });
} else {
  if (trigger) {
    await checkpoint('gateway-stop');
    await checkpoint('cold-restart');
  }
  // A cold start with the gateway stopped: the history comes from the store alone.
  const state = await until(
    (next) => next.status !== 'connected' && next.history?.rows !== undefined,
    'No stored history after the cold start',
    'run-list-version-fill:open-history',
  );
  const expected = values['expect-total'] ? Number(values['expect-total']) : undefined;
  const ok = offlineTotalsHold(state, { expected, minRuns });
  print({
    ok,
    runListOfflineTotals: ok,
    status: state.status,
    historyStatus: state.history.status,
    historyRuns: state.history.rows,
    totalCount: state.history.totalCount,
    framesSent: state.framesSent,
    runListReplies: state.frames.length,
  });
}
