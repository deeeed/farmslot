import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runSessionArchiveDir } from '../runs/store.js';

import { retainFailedStepLog } from './failed-step-log.js';

async function slotLog(t: import('node:test').TestContext, content: string) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'prepare-logs-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = path.join(dir, 'deps.log');
  await writeFile(log, content);
  return log;
}

test('a failed run keeps its own copy of the slot log, which the next prepare cannot overwrite', async (t) => {
  const runId = `failed-log-${process.pid}-a`;
  t.after(() => rm(runSessionArchiveDir(runId), { recursive: true, force: true }));
  const log = await slotLog(t, 'YN0028: lockfile would be modified\n');

  const kept = await retainFailedStepLog(
    runId,
    log,
    `yarn install failed (exit 1) — log: ${log}`,
    new Date('2026-11-24T10:00:00.000Z'),
  );

  assert.equal(
    kept.logPath,
    path.join(runSessionArchiveDir(runId), 'prepare-logs', 'deps-2026-11-24T10-00-00-000Z.log'),
  );
  assert.equal(kept.message, `yarn install failed (exit 1) — log: ${kept.logPath}`);
  await writeFile(log, 'the next run on this slot\n');
  assert.equal(await readFile(kept.logPath!, 'utf8'), 'YN0028: lockfile would be modified\n');
});

test('each failure of a replayed run keeps its own copy', async (t) => {
  const runId = `failed-log-${process.pid}-b`;
  t.after(() => rm(runSessionArchiveDir(runId), { recursive: true, force: true }));
  const log = await slotLog(t, 'first\n');
  const first = await retainFailedStepLog(runId, log, log, new Date('2026-11-24T10:00:00Z'));
  await writeFile(log, 'second\n');
  const second = await retainFailedStepLog(runId, log, log, new Date('2026-11-24T10:05:00Z'));
  assert.notEqual(first.logPath, second.logPath);
  assert.equal(await readFile(first.logPath!, 'utf8'), 'first\n');
  assert.equal(await readFile(second.logPath!, 'utf8'), 'second\n');
});

test('a log that cannot be copied leaves the step naming the slot log', async (t) => {
  const runId = `failed-log-${process.pid}-c`;
  t.after(() => rm(runSessionArchiveDir(runId), { recursive: true, force: true }));
  const missing = path.join(os.tmpdir(), `no-such-prepare-log-${process.pid}.log`);
  const warnings: string[] = [];
  t.mock.method(console, 'warn', (line: string) => warnings.push(line));
  assert.deepEqual(await retainFailedStepLog(runId, missing, `log: ${missing}`), {
    logPath: missing,
    message: `log: ${missing}`,
  });
  assert.match(warnings.join('\n'), /could not keep a copy of .*no-such-prepare-log/);
  assert.deepEqual(await retainFailedStepLog(runId, undefined, 'no log'), {
    logPath: undefined,
    message: 'no log',
  });
});
