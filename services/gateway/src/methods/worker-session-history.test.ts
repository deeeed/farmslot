import assert from 'node:assert/strict';
import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { archiveRunnerSessionsForSlotRelease } from '../runners/session-archive.js';
import { createRun, deleteRun, getRun, updateRun } from '../runs/store.js';

import { workerSessionHistoryEnabled, workerSessionHistoryGet } from './worker-session-history.js';

test('worker session history is enabled by default and can be explicitly disabled', (t) => {
  const previous = process.env.FARMSLOT_EXPERIMENTAL_WORKER_HISTORY;
  t.after(() => {
    if (previous === undefined) delete process.env.FARMSLOT_EXPERIMENTAL_WORKER_HISTORY;
    else process.env.FARMSLOT_EXPERIMENTAL_WORKER_HISTORY = previous;
  });

  delete process.env.FARMSLOT_EXPERIMENTAL_WORKER_HISTORY;
  assert.equal(workerSessionHistoryEnabled(), true);

  process.env.FARMSLOT_EXPERIMENTAL_WORKER_HISTORY = '1';
  assert.equal(workerSessionHistoryEnabled(), true);

  process.env.FARMSLOT_EXPERIMENTAL_WORKER_HISTORY = '0';
  assert.equal(workerSessionHistoryEnabled(), false);
});

test('history.get projects a recycle snapshot when the live transcript is gone', async (t) => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'fs-history-archive-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const sessionPath = path.join(tmp, 'session.jsonl');
  await writeFile(
    sessionPath,
    `${JSON.stringify({
      uuid: 'u1',
      type: 'user',
      message: { content: [{ type: 'text', text: 'What did we try?' }] },
      timestamp: '2026-09-12T11:00:00Z',
    })}\n${JSON.stringify({
      uuid: 'a1',
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'We inspected the file.' }] },
    })}\n`,
    'utf8',
  );

  const run = createRun({
    flowType: 'dev',
    mode: 'autonomous',
    project: 'farmslot-farm',
    ticketOrPr: `HISTORY-ARCHIVE-${Date.now()}`,
    runner: 'claude',
  });
  t.after(async () => {
    if (!getRun(run.id)) return;
    updateRun(run.id, { status: 'done', completedAt: new Date().toISOString() });
    await deleteRun(run.id);
  });
  updateRun(run.id, {
    metrics: {
      ...run.metrics,
      runner: 'claude',
      runnerSessionId: 'sess-history',
      runnerSessionPath: sessionPath,
    },
  });

  await archiveRunnerSessionsForSlotRelease({
    vars: { host: 'localhost', machine: 'test', sshTarget: 'localhost' },
    runId: run.id,
  });
  await unlink(sessionPath);

  const { snapshot } = await workerSessionHistoryGet({ runId: run.id });
  assert.equal(snapshot.source, 'transcript-archive');
  assert.equal(snapshot.messages[0]?.text, 'What did we try?');
  assert.equal(snapshot.messages[1]?.text, 'We inspected the file.');
  assert.match(snapshot.degradedReason ?? '', /recycle snapshot/);
});
