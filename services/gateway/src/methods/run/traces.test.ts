import assert from 'node:assert/strict';
import { readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { runEpisodeDir } from '../../run-completion/run-episode.js';
import { createRun, deleteRun, getRun, updateRun } from '../../runs/store.js';

import { runEpisodeRecapture, runGradeExternalRecord, runInterviewRecord } from './traces.js';

const principal = { id: 'farm-automation' };

function endedRun(t: TestContext, completedAt = new Date().toISOString()) {
  const run = createRun({
    flowType: 'dev',
    mode: 'autonomous',
    project: 'farmslot-farm',
    ticketOrPr: `TRACE-${Date.now()}-${Math.random()}`,
  });
  updateRun(run.id, { status: 'done', completedAt });
  t.after(async () => {
    if (getRun(run.id)) await deleteRun(run.id);
    await rm(path.join(runEpisodeDir(), 'grades', `${run.id}.jsonl`), { force: true });
    await rm(path.join(runEpisodeDir(), 'interviews', run.id), { recursive: true, force: true });
  });
  return run.id;
}

test('an external grade appends one line with the grader and the recording principal', async (t) => {
  const runId = endedRun(t);
  const first = await runGradeExternalRecord(
    {
      runId,
      source: 'sparks-eval-phase2',
      grader: 'sparks',
      scale: ['match', 'partial', 'wrong'],
      verdict: 'partial',
      rubric: [{ point: 'Order book opens first', verdict: 'met' }],
      reason: 'One criterion missed.',
      gradedAt: '2026-11-24T10:00:00Z',
    },
    principal,
  );
  assert.equal(first.grade.recordedBy, 'farm-automation');
  assert.equal(first.grade.gradedAt, '2026-11-24T10:00:00.000Z');
  // A correction is a new line.
  await runGradeExternalRecord(
    {
      runId,
      source: 'sparks-eval-phase2',
      grader: 'sparks',
      scale: ['match', 'wrong'],
      verdict: 'match',
    },
    principal,
  );
  const lines = (await readFile(path.join(runEpisodeDir(), 'grades', `${runId}.jsonl`), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    lines.map((line) => line.verdict),
    ['partial', 'match'],
  );
});

test('a grade outside its scale, or for an unknown run, is refused', async (t) => {
  const runId = endedRun(t);
  await assert.rejects(
    runGradeExternalRecord(
      { runId, source: 's', grader: 'g', scale: ['match'], verdict: 'wrong' },
      principal,
    ),
    /verdict must be one of: match/,
  );
  await assert.rejects(
    runGradeExternalRecord(
      { runId: 'no-such-run', source: 's', grader: 'g', scale: ['match'], verdict: 'match' },
      principal,
    ),
    /Run not found/,
  );
});

test('interviews take the next number and refuse an unknown kind', async (t) => {
  const runId = endedRun(t);
  const files = await Promise.all([
    runInterviewRecord({ runId, kind: 'why', text: 'Because the task said so.' }),
    runInterviewRecord({ runId, kind: 'note', text: 'Second.' }),
  ]);
  assert.deepEqual(files.map((entry) => entry.file).sort(), ['001-why.md', '002-note.md'].sort());
  const stored = (await readdir(path.join(runEpisodeDir(), 'interviews', runId))).filter(
    (name) => !name.startsWith('.'),
  );
  assert.equal(stored.length, 2);
  await assert.rejects(
    // @ts-expect-error -- a kind outside the enum is refused at runtime, never used as a path
    runInterviewRecord({ runId, kind: '../escape', text: 'x' }),
    /kind must be one of/,
  );
});

test('recapture queues only runs that ended in the range', async (t) => {
  endedRun(t, '2020-01-01T00:00:00Z');
  const inRange = endedRun(t, '2026-11-24T10:00:00Z');
  const result = await runEpisodeRecapture({
    since: '2026-11-24T00:00:00Z',
    until: '2026-11-24T23:59:59Z',
  });
  assert.ok(result.queued >= 1);
  assert.ok(getRun(inRange));
  await assert.rejects(runEpisodeRecapture({ since: 'yesterday-ish' }), /ISO timestamp/);
});
