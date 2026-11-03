import assert from 'node:assert/strict';
import fs from 'node:fs';
import { appendFile, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import type { RunDecision } from '@farmslot/protocol';

import { deleteTestRunIfPresent } from '../run-engine/test-fixtures.js';

import * as store from './store.js';
import {
  archiveRun,
  buildRunRecord,
  commitRunPublication,
  createRun,
  deleteArchivedRun,
  discardUndurableRun,
  getRun,
  getRunWithArchived,
  isSyntheticLeak,
  loadAllRuns,
  persistRunNow,
  quarantineLeakedRun,
  runsDirectory,
  updateRun,
} from './store.js';

const row = (description: string): RunDecision => ({
  id: 'repeated-id',
  type: 'engine_human_gate',
  title: 'Publish',
  description,
  actions: [],
  createdAt: '2026-11-03T00:00:00.000Z',
  resolvedAt: '2026-11-03T00:01:00.000Z',
  resolvedAction: 'hold',
  selectionData: { packageId: description },
  context: { receiptId: 'retained-receipt' },
});

test(
  'decision replacements retain whole rows and duplicate occurrences on disk',
  { timeout: 4000 },
  async (t) => {
    const run = createRun({ flowType: 'dev', project: 'example-history', ticketOrPr: 'HISTORY' });
    t.after(() => deleteTestRunIfPresent(run.id));
    const first = row('first ' + 'x'.repeat(100_000));
    const second = row('second');
    const original = structuredClone([first, second, first]);
    updateRun(run.id, { decisions: [first, second, first] });
    updateRun(run.id, { decisions: [structuredClone(second)] });
    assert.deepEqual(store.readDecisionHistory(run.id), [original[0], original[2]]);
    const updated = { ...second, description: 'updated readiness' };
    updateRun(run.id, { decisions: [updated] });
    assert.deepEqual(store.readDecisionHistory(run.id), [original[0], original[2]]);
    first.description = 'changed outside the store';
    updateRun(run.id, { decisions: [] });
    updateRun(run.id, { decisions: [] });
    const history = [original[0], original[2], updated];
    assert.deepEqual(store.readDecisionHistory(run.id), history);
    await persistRunNow(getRun(run.id)!);
    const persisted = JSON.parse(
      await readFile(path.join(runsDirectory(), `${run.id}.json`), 'utf8'),
    );
    assert.deepEqual(persisted.decisions, []);
    assert.equal(Object.hasOwn(persisted, 'decisionHistory'), false);
    assert.equal(persisted.decisionHistoryCount, history.length);
    assert.ok(Buffer.byteLength(JSON.stringify(persisted)) < 16_384);
    assert.ok((await readFile(historyFile(run.id))).byteLength > 200_000);
    assert.equal(
      await readFile(historyFile(run.id), 'utf8'),
      history.map((row) => JSON.stringify(row) + '\n').join(''),
    );
  },
);

test('a stale patch cannot lower or replace the history count', { timeout: 4000 }, async (t) => {
  const run = createRun({ flowType: 'dev', project: 'example-history', ticketOrPr: 'APPEND' });
  t.after(() => deleteTestRunIfPresent(run.id));
  updateRun(run.id, { decisions: [row('retained')] });
  updateRun(run.id, { decisions: [] });
  const before = structuredClone(getRun(run.id));
  for (const decisionHistoryCount of [0, undefined, 99]) {
    assert.throws(() => updateRun(run.id, { decisionHistoryCount }), {
      message: 'Decision history count is managed by the run store and cannot be replaced',
    });
    assert.deepEqual(getRun(run.id), before);
  }
  updateRun(run.id, { ...getRun(run.id)! });
  assert.equal(getRun(run.id)!.decisionHistoryCount, 1);
});

for (const archived of [false, true]) {
  test(
    `publication commits retain decisions in ${archived ? 'archived' : 'live'} run records`,
    { timeout: 4000 },
    async (t) => {
      const run = createRun({
        flowType: 'dev',
        project: 'example-history',
        ticketOrPr: 'PROJ-351',
      });
      t.after(async () => {
        if (getRun(run.id)) await deleteTestRunIfPresent(run.id);
        else await deleteArchivedRun(run.id);
      });
      const original = row('publication');
      updateRun(run.id, { status: 'cancelled', decisions: [original] });
      if (archived) assert.equal(await archiveRun(run.id), true);
      await commitRunPublication(run.id, (current) => ({
        prNumber: 351,
        links: current.links,
        prPublications: current.prPublications,
        decisions: [],
      }));
      const retained = await getRunWithArchived(run.id);
      assert.deepEqual(retained?.decisions, []);
      assert.deepEqual(store.readDecisionHistory(run.id), [original]);
      assert.equal(retained?.decisionHistoryCount, 1);
      const dir = path.join(runsDirectory(), ...(archived ? ['archive'] : []));
      assert.equal(
        await readFile(path.join(dir, `${run.id}.decisions.jsonl`), 'utf8'),
        JSON.stringify(original) + '\n',
      );
    },
  );
}

test('a run with only decision history is not a synthetic leak', () => {
  const run = buildRunRecord({
    flowType: 'dev',
    project: 'example-history',
    ticketOrPr: 'PROJ-351',
  });
  run.status = 'done';
  run.metrics.runner = null;
  run.completedAt = run.createdAt;
  run.decisionHistoryCount = 1;
  assert.equal(isSyntheticLeak(run), false);
});

const historyFile = (id: string, archived = false) =>
  path.join(runsDirectory(), ...(archived ? ['archive'] : []), `${id}.decisions.jsonl`);

test('retired rows and count survive a cold disk load', { timeout: 4000 }, async (t) => {
  const run = createRun({ flowType: 'dev', project: 'example-history', ticketOrPr: 'COLD' });
  t.after(() => deleteTestRunIfPresent(run.id));
  const original = [row('cold'), row('duplicate'), row('duplicate')];
  updateRun(run.id, { decisions: original });
  updateRun(run.id, { decisions: [] });
  await persistRunNow(run);
  await loadAllRuns();
  const loaded = getRun(run.id)!;
  assert.notEqual(loaded, run, 'load must install the parsed disk record');
  assert.deepEqual(loaded.decisions, []);
  assert.equal(loaded.decisionHistoryCount, 3);
  assert.deepEqual(store.readDecisionHistory(run.id), original);
  assert.equal(Object.hasOwn(loaded, 'decisionHistory'), false);
});

test(
  'history reader skips a torn last line and rejects corrupt complete lines',
  { timeout: 4000 },
  async (t) => {
    const run = createRun({ flowType: 'dev', project: 'example-history', ticketOrPr: 'TORN' });
    t.after(() => deleteTestRunIfPresent(run.id));
    assert.deepEqual(store.readDecisionHistory(run.id), []);
    const original = row('intact');
    updateRun(run.id, { decisions: [original] });
    updateRun(run.id, { decisions: [] });
    await appendFile(historyFile(run.id), '{"id":');
    assert.deepEqual(store.readDecisionHistory(run.id), [original]);
    await appendFile(historyFile(run.id), '\n');
    assert.throws(() => store.readDecisionHistory(run.id), SyntaxError);
  },
);

test('a torn last line does not block the next retirement', { timeout: 4000 }, async (t) => {
  const run = createRun({ flowType: 'dev', project: 'example-history', ticketOrPr: 'TORN-NEXT' });
  t.after(() => deleteTestRunIfPresent(run.id));
  const first = row('first');
  const second = row('second');
  updateRun(run.id, { decisions: [first] });
  updateRun(run.id, { decisions: [] });
  await appendFile(historyFile(run.id), '{"id":');
  updateRun(run.id, { decisions: [second] });
  updateRun(run.id, { decisions: [] });
  assert.deepEqual(store.readDecisionHistory(run.id), [first, second]);
  assert.equal(getRun(run.id)?.decisionHistoryCount, 2);
});

for (const mode of ['update', 'publication-live', 'publication-archive'] as const) {
  test(
    `an append failure refuses ${mode} before changing the run`,
    { timeout: 4000 },
    async (t) => {
      const run = createRun({ flowType: 'dev', project: 'example-history', ticketOrPr: 'FAIL' });
      const archived = mode === 'publication-archive';
      t.after(async () => {
        await rm(historyFile(run.id, archived), { recursive: true, force: true });
        if (getRun(run.id)) await deleteTestRunIfPresent(run.id);
        else await deleteArchivedRun(run.id);
      });
      updateRun(run.id, { status: 'cancelled', decisions: [row('cannot lose')] });
      await persistRunNow(run);
      if (archived) assert.equal(await archiveRun(run.id), true);
      const before = structuredClone(await getRunWithArchived(run.id));
      const recordFile = path.join(path.dirname(historyFile(run.id, archived)), `${run.id}.json`);
      const disk = await readFile(recordFile, 'utf8');
      await mkdir(historyFile(run.id, archived));
      if (mode === 'update') assert.throws(() => updateRun(run.id, { decisions: [] }));
      else
        await assert.rejects(
          commitRunPublication(run.id, (current) => ({
            prNumber: 351,
            links: current.links,
            prPublications: current.prPublications,
            decisions: [],
          })),
        );
      assert.deepEqual(await getRunWithArchived(run.id), before);
      assert.equal(await readFile(recordFile, 'utf8'), disk);
    },
  );
}

test('history reaches disk before the shorter list is exposed', { timeout: 4000 }, async (t) => {
  const run = createRun({ flowType: 'dev', project: 'example-history', ticketOrPr: 'ORDER' });
  t.after(() => deleteTestRunIfPresent(run.id));
  const original = row('sync');
  updateRun(run.id, { decisions: [original] });
  await persistRunNow(run);
  const sync = fs.fsyncSync;
  let synced = false;
  t.mock.method(fs, 'fsyncSync', (fd: number) => {
    assert.deepEqual(getRun(run.id)!.decisions, [original]);
    assert.equal(fs.readFileSync(historyFile(run.id), 'utf8'), JSON.stringify(original) + '\n');
    synced = true;
    return sync(fd);
  });
  updateRun(run.id, { decisions: [] });
  assert.equal(synced, true);
  t.mock.restoreAll();
  assert.equal(run.decisionHistoryCount, 1);
});

test('archive moves the history file and deletion removes it', { timeout: 4000 }, async (t) => {
  const run = createRun({ flowType: 'dev', project: 'example-history', ticketOrPr: 'MOVE' });
  t.after(async () => {
    if (getRun(run.id)) await deleteTestRunIfPresent(run.id);
    else await deleteArchivedRun(run.id);
  });
  const original = row('move');
  updateRun(run.id, { status: 'cancelled', decisions: [original] });
  updateRun(run.id, { decisions: [] });
  await persistRunNow(run);
  const bytes = await readFile(historyFile(run.id));
  assert.equal(await archiveRun(run.id), true);
  assert.deepEqual(await readFile(historyFile(run.id, true)), bytes);
  assert.equal(fs.existsSync(historyFile(run.id)), false);
  assert.deepEqual(store.readDecisionHistory(run.id), [original]);
  await deleteArchivedRun(run.id);
  assert.equal(fs.existsSync(historyFile(run.id, true)), false);
});

for (const removal of ['delete', 'discard', 'quarantine'] as const) {
  test(`${removal} carries the history file with its record`, { timeout: 4000 }, async (t) => {
    const run = createRun({ flowType: 'dev', project: 'example-history', ticketOrPr: 'REMOVE' });
    t.after(() => deleteTestRunIfPresent(run.id));
    updateRun(run.id, { decisions: [row('remove')] });
    updateRun(run.id, { decisions: [] });
    await persistRunNow(run);
    assert.equal(await readFile(historyFile(run.id), 'utf8'), JSON.stringify(row('remove')) + '\n');
    if (removal === 'delete') await deleteTestRunIfPresent(run.id);
    else if (removal === 'discard') await discardUndurableRun(run.id);
    else {
      await quarantineLeakedRun(run);
      const dir = path.join(runsDirectory(), 'quarantine');
      const record = fs
        .readdirSync(dir)
        .find((file) => file.startsWith(run.id) && file.endsWith('.json'))!;
      assert.equal(
        fs.readFileSync(path.join(dir, record.replace(/\.json$/, '.decisions.jsonl')), 'utf8'),
        JSON.stringify(row('remove')) + '\n',
      );
    }
    assert.equal(fs.existsSync(historyFile(run.id)), false);
  });
}
