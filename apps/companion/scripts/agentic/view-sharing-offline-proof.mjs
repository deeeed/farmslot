#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { workerInstructionAttempts } from './terminal-control-replies.mjs';

const root = fileURLToPath(new URL('../../../../', import.meta.url)).replace(/\/$/, '');
const caseDir = process.env.FARMSLOT_VIEW_SHARING_CASE;
const artifactDir = process.env.FARMSLOT_RECIPE_ARTIFACTS_DIR;
const mode = process.argv[2];
assert(caseDir && artifactDir);
const fixture = JSON.parse(await readFile(path.join(caseDir, 'fixture.json'), 'utf8'));
assert.equal(fixture.sourceRoot, root);
const save = (name, value) =>
  writeFile(path.join(artifactDir, name + '.json'), JSON.stringify(value, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
async function counts() {
  const response = await fetch(process.env.FARMSLOT_VIEW_SHARING_COUNTS_URL, {
    signal: AbortSignal.timeout(3000),
  });
  assert(response.ok);
  const current = await response.json();
  assert.equal(current.sourceRoot, root);
  assert.equal(current.caseDir, caseDir);
  assert.equal(current.startId, process.env.FARMSLOT_VIEW_SHARING_PROXY_START_ID);
  assert.equal(current.failure, null);
  return current;
}
if (mode === 'begin') {
  const marker = JSON.parse(await readFile(path.join(caseDir, 'planned-offline.json'), 'utf8'));
  const current = await counts();
  assert.equal(marker.sourceRoot, root);
  assert.equal(marker.caseDir, caseDir);
  assert.equal(marker.proxyStartId, current.startId);
  assert.equal(marker.proxyPid, current.pid);
  assert.equal(marker.kind, 'view-sharing-offline');
  const stop = JSON.parse(
    await readFile(process.env.FARMSLOT_VIEW_SHARING_GATEWAY_STOP_RECEIPT, 'utf8'),
  );
  assert.deepEqual(stop.remaining, []);
  assert(stop.owner.pid > 0);
  try {
    await fetch('http://127.0.0.1:' + fixture.gatewayPort + '/health', {
      signal: AbortSignal.timeout(2000),
    });
    assert.fail('The actual owned Gateway must be offline');
  } catch (error) {
    assert.equal(
      error.cause?.code,
      'ECONNREFUSED',
      'Only a refused Gateway connection proves the prepared outage',
    );
  }
  await save(mode, { marker, current, stop });
} else if (mode === 'copied' || mode === 'recovered') {
  const baseline = JSON.parse(
    await readFile(process.env.FARMSLOT_VIEW_SHARING_OFFLINE_BASELINE, 'utf8'),
  );
  let current = await counts();
  if (mode === 'recovered') {
    const recovery = JSON.parse(
      await readFile(process.env.FARMSLOT_VIEW_SHARING_GATEWAY_RECOVERY_RECEIPT, 'utf8'),
    );
    assert(
      recovery.owner.pid > 0 &&
        recovery.startedAtMs > Date.parse(baseline.current.startAt) &&
        Number.isFinite(recovery.startedAtMs),
    );
    const deadline = Date.now() + 15000;
    let fresh;
    do {
      current = await counts();
      fresh = current.requests.find(
        (q) =>
          q.origin === process.env.FARMSLOT_VIEW_SHARING_NATIVE_ORIGIN &&
          q.method === 'run.get' &&
          q.runId === fixture.runs[0].id &&
          q.at >= recovery.startedAtMs &&
          current.responses.some(
            (r) =>
              r.connectionId === q.connectionId && r.id === q.id && r.ok && r.runId === q.runId,
          ),
      );
      if (fresh) break;
      assert(Date.now() < deadline, 'The mounted app did not recover a fresh run read');
      await delay(250);
    } while (!fresh);
    await save('fresh-recovery-read', { recovery, request: fresh });
  } else {
    const clipboard = JSON.parse(
      await readFile(path.join(artifactDir, 'native-clipboard.json'), 'utf8'),
    );
    assert.equal(clipboard.url, process.env.FARMSLOT_VIEW_SHARING_EXPECTED_URL);
  }
  assert.deepEqual(
    workerInstructionAttempts(current),
    workerInstructionAttempts(baseline.current),
    'Copy and recovery must not send or replay any instruction',
  );
  await save(mode, { current, instructionsUnchanged: true });
} else throw new Error('Unknown offline proof mode ' + mode);
console.log(JSON.stringify({ status: 'PASS', mode }));
