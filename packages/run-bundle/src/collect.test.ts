import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadAllRunRecords, loadRunRecord, selectRunsForExport } from './collect.js';

test('run records skip non-run JSON that shares the runs directory', (t) => {
  const runsDir = mkdtempSync(path.join(tmpdir(), 'farmrun-collect-'));
  t.after(() => rmSync(runsDir, { recursive: true, force: true }));
  const runId = 'a1b2c3d4-1111-4222-8333-444455556666';
  const capabilityStore = { version: 1, leases: [], proofPlans: {}, events: [] };
  const run = { id: runId, status: 'done', steps: [], createdAt: '2026-09-26T08:00:00.000Z' };
  writeFileSync(path.join(runsDir, `${runId}.json`), JSON.stringify(run));
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
    JSON.stringify({ ...run, id: 'b2c3d4e5-1111-4222-8333-444455556666' }),
  );
  // Filename-matched JSON without the run shape is not a run either.
  writeFileSync(path.join(runsDir, 'foo.json'), JSON.stringify({ id: 'foo' }));

  assert.deepEqual(
    loadAllRunRecords(runsDir).map((run) => run.id),
    [runId],
  );
  assert.equal(loadRunRecord(runsDir, 'runtime'), null);
  assert.equal(loadRunRecord(runsDir, 'undefined'), null);
  assert.equal(loadRunRecord(runsDir, 'foo'), null);
  assert.equal(loadRunRecord(runsDir, runId.slice(0, 8))?.id, runId);
  // A non-run file sorting before the run under the same prefix must not hide it.
  writeFileSync(path.join(runsDir, 'a1b2-copy.json'), JSON.stringify(capabilityStore));
  assert.equal(loadRunRecord(runsDir, 'a1b2')?.id, runId);
});

for (const archived of [false, true]) {
  test(`explicit ${archived ? 'archived' : 'live'} ids skip unrelated records`, (t) => {
    const root = mkdtempSync(path.join(tmpdir(), 'farmrun-select-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const runsDir = path.join(root, '.runs');
    const archiveDir = path.join(runsDir, 'archive');
    mkdirSync(archiveDir, { recursive: true });
    const id = 'a1b2c3d4-1111-4222-8333-444455556666';
    const run = { id, status: 'done', steps: [], createdAt: '2026-11-03T00:00:00Z' };
    writeFileSync(path.join(archived ? archiveDir : runsDir, `${id}.json`), JSON.stringify(run));
    writeFileSync(path.join(runsDir, 'unrelated.json'), '{"id":');
    writeFileSync(path.join(archiveDir, 'unrelated.json'), '{"id":');
    assert.deepEqual(selectRunsForExport({ farmslotRoot: root, runIds: [id, id] }), [run]);
  });
}
