import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadAllRunRecords, loadRunRecord } from './collect.js';

test('run records skip non-run JSON that shares the runs directory', (t) => {
  const runsDir = mkdtempSync(path.join(tmpdir(), 'farmrun-collect-'));
  t.after(() => rmSync(runsDir, { recursive: true, force: true }));
  const runId = 'a1b2c3d4-1111-4222-8333-444455556666';
  const capabilityStore = { version: 1, leases: [], proofPlans: {}, events: [] };
  writeFileSync(path.join(runsDir, `${runId}.json`), JSON.stringify({ id: runId, status: 'done' }));
  writeFileSync(
    path.join(runsDir, 'runtime-capabilities-7777.json'),
    JSON.stringify(capabilityStore),
  );
  writeFileSync(
    path.join(runsDir, 'undefined.json'),
    JSON.stringify({ ...capabilityStore, lane: 'production' }),
  );
  writeFileSync(
    path.join(runsDir, 'stale-copy.json'),
    JSON.stringify({ id: 'b2c3d4e5-1111-4222-8333-444455556666', status: 'done' }),
  );

  assert.deepEqual(
    loadAllRunRecords(runsDir).map((run) => run.id),
    [runId],
  );
  assert.equal(loadRunRecord(runsDir, 'runtime'), null);
  assert.equal(loadRunRecord(runsDir, 'undefined'), null);
  assert.equal(loadRunRecord(runsDir, runId.slice(0, 8))?.id, runId);
  // A non-run file sorting before the run under the same prefix must not hide it.
  writeFileSync(path.join(runsDir, 'a1b2-copy.json'), JSON.stringify(capabilityStore));
  assert.equal(loadRunRecord(runsDir, 'a1b2')?.id, runId);
});
