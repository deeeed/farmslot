import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { latestFullReceipts, verifyFullReceipts } from './full-ci-receipts.mjs';
import { runFullJob } from './full-ci-run.mjs';

const task = (id, node = 22) => ({ id, node, command: `echo ${id}`, cwd: '.' });
function fixture() {
  const plan = {
    version: 1,
    mode: 'full',
    sha: 'sha',
    prerequisites: true,
    coverage: { diff: { missingFiles: [], addedFiles: [], missingGuards: [], addedGuards: [] } },
    jobs: [{ id: 'guards', tasks: [task('a'), task('compatibility', 24)] }],
    desktop: { id: 'desktop', tasks: [task('mac')] },
  };
  const receipts = [...plan.jobs, plan.desktop].map((job) => ({
    id: job.id,
    sha: plan.sha,
    status: 'ok',
    tasks: job.tasks.map((entry) => ({ ...entry, status: 0 })),
  }));
  return { plan, receipts, results: { prepare: 'success', checks: 'success', desktop: 'success' } };
}

test('aggregate rejects missing jobs, failed commands, stale source and missing Node24', () => {
  const { plan, receipts, results } = fixture();
  assert.doesNotThrow(() => verifyFullReceipts(plan, receipts, results));
  for (const mutate of [
    (rows) => rows.pop(),
    (rows) => {
      rows[0].tasks[0].status = 1;
    },
    (rows) => {
      rows[0].sha = 'old';
    },
    (rows) => {
      rows[0].tasks.pop();
    },
  ]) {
    const copy = structuredClone(receipts);
    mutate(copy);
    assert.throws(() => verifyFullReceipts(plan, copy, results));
  }
  assert.throws(
    () => verifyFullReceipts(plan, receipts, { ...results, checks: 'failure' }),
    /job result/,
  );
});

test('latest attempt replaces failures and never falls back from a new failed attempt', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'full-receipts-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (attempt, receipt) => {
    const dir = path.join(root, `full-ci-guards-attempt-${attempt}`);
    mkdirSync(dir);
    writeFileSync(path.join(dir, 'guards.json'), JSON.stringify(receipt));
  };
  write(9, { id: 'guards', status: 'fail' });
  write(10, { id: 'guards', status: 'ok' });
  assert.equal(latestFullReceipts(root)[0].status, 'ok');
  write(11, { id: 'guards', status: 'fail' });
  assert.equal(latestFullReceipts(root)[0].status, 'fail');
});

test('worker continues independent tasks, and Node24 is required before a mixed job is complete', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'full-worker-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { plan } = fixture();
  const calls = [];
  const spawn = (_program, args, options) => {
    calls.push(args.at(-1));
    assert.equal(options.env.FARMSLOT_CI_TEST_SELECTION, undefined);
    return { status: args.at(-1) === 'echo a' ? 1 : 0 };
  };
  const first = runFullJob(plan, plan.jobs[0], root, spawn, 22);
  assert.equal(first.stageStatus, 'fail');
  assert.equal(first.status, 'running');
  const second = runFullJob(plan, plan.jobs[0], root, spawn, 24);
  assert.deepEqual(calls, ['echo a', 'echo compatibility']);
  assert.equal(second.stageStatus, 'ok');
  assert.equal(second.status, 'fail');
  assert.equal(second.tasks.length, 2);
});
