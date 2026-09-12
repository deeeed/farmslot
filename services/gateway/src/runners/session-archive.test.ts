import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  archiveRun,
  createRun,
  deleteRun,
  getRun,
  runSessionArchiveDir,
  updateRun,
} from '../runs/store.js';

import {
  archiveRunnerSessionsForSlotRelease,
  runnerSessionArchiveContextDir,
} from './session-archive.js';

const localVars = { host: 'localhost', machine: 'test', sshTarget: 'localhost' };

test('archive context dirs never treat dot segments as parent paths', () => {
  assert.match(runnerSessionArchiveContextDir('run-1', '..'), /run-1[/\\]context$/);
  assert.match(runnerSessionArchiveContextDir('run-1', '.'), /run-1[/\\]context$/);
});

const CLAUDE_LINES = [
  JSON.stringify({
    uuid: 'u1',
    type: 'user',
    message: { content: [{ type: 'text', text: 'Inspect the file.' }] },
    timestamp: '2026-09-12T10:00:00Z',
  }),
  JSON.stringify({
    uuid: 'a1',
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'Done.' }] },
  }),
];

async function cleanupRun(runId: string): Promise<void> {
  if (!getRun(runId)) return;
  updateRun(runId, { status: 'done', completedAt: new Date().toISOString() });
  await deleteRun(runId);
}

test('archives a claude jsonl transcript next to the run store', async (t) => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'fs-session-archive-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const sessionPath = path.join(tmp, 'session.jsonl');
  await writeFile(sessionPath, `${CLAUDE_LINES.join('\n')}\n`, 'utf8');

  const run = createRun({
    flowType: 'dev',
    mode: 'autonomous',
    project: 'farmslot-farm',
    ticketOrPr: `ARCHIVE-${Date.now()}-claude`,
    runner: 'claude',
  });
  t.after(() => cleanupRun(run.id));
  updateRun(run.id, {
    metrics: {
      ...run.metrics,
      runner: 'claude',
      runnerSessionId: 'sess-claude',
      runnerSessionPath: sessionPath,
    },
  });

  const first = await archiveRunnerSessionsForSlotRelease({ vars: localVars, runId: run.id });
  assert.equal(first.captured, 1);
  const stored = getRun(run.id);
  assert.equal(stored?.metrics.runnerSessionArchive?.status, 'captured');
  assert.equal(stored?.metrics.runnerSessionArchive?.kind, 'jsonl');
  assert.equal(stored?.metrics.runnerSessionArchive?.originalPath, sessionPath);
  assert.match(stored?.metrics.runnerSessionArchive?.relativeDir ?? '', /session-archives\//);

  const second = await archiveRunnerSessionsForSlotRelease({ vars: localVars, runId: run.id });
  assert.equal(second.captured, 0);
  assert.equal(second.skipped, 1);
});

test('resolves a grok session directory to chat_history.jsonl', async (t) => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'fs-session-archive-grok-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const sessionDir = path.join(tmp, 'abc');
  await mkdir(sessionDir);
  const jsonl = path.join(sessionDir, 'chat_history.jsonl');
  await writeFile(
    jsonl,
    `${JSON.stringify({ role: 'user', content: 'Summarize status.' })}\n`,
    'utf8',
  );

  const run = createRun({
    flowType: 'dev',
    mode: 'autonomous',
    project: 'farmslot-farm',
    ticketOrPr: `ARCHIVE-${Date.now()}-grok`,
    runner: 'grok',
  });
  t.after(() => cleanupRun(run.id));
  updateRun(run.id, {
    metrics: {
      ...run.metrics,
      runner: 'grok',
      runnerSessionPath: sessionDir,
    },
  });

  const result = await archiveRunnerSessionsForSlotRelease({ vars: localVars, runId: run.id });
  assert.equal(result.captured, 1);
  assert.equal(getRun(run.id)?.metrics.runnerSessionArchive?.originalPath, jsonl);
});

test('records missing when the live transcript path is gone', async (t) => {
  const run = createRun({
    flowType: 'dev',
    mode: 'autonomous',
    project: 'farmslot-farm',
    ticketOrPr: `ARCHIVE-${Date.now()}-missing`,
    runner: 'claude',
  });
  t.after(() => cleanupRun(run.id));
  updateRun(run.id, {
    metrics: {
      ...run.metrics,
      runner: 'claude',
      runnerSessionPath: path.join(os.tmpdir(), `no-such-session-${Date.now()}.jsonl`),
    },
  });

  const result = await archiveRunnerSessionsForSlotRelease({ vars: localVars, runId: run.id });
  assert.equal(result.captured, 0);
  assert.equal(result.missing, 1);
  assert.equal(getRun(run.id)?.metrics.runnerSessionArchive?.status, 'missing');
});

test('archives from metrics when agent contexts have no session path', async (t) => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'fs-session-archive-metrics-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const sessionPath = path.join(tmp, 'session.jsonl');
  await writeFile(sessionPath, `${CLAUDE_LINES.join('\n')}\n`, 'utf8');

  const run = createRun({
    flowType: 'dev',
    mode: 'autonomous',
    project: 'farmslot-farm',
    ticketOrPr: `ARCHIVE-${Date.now()}-metrics`,
    runner: 'claude',
  });
  t.after(() => cleanupRun(run.id));
  updateRun(run.id, {
    agentContexts: [
      {
        id: 'dev',
        role: 'dev',
        label: 'Worker',
        status: 'complete',
        slotId: '',
        runId: run.id,
        runner: 'claude',
      },
    ],
    metrics: {
      ...run.metrics,
      runner: 'claude',
      runnerSessionPath: sessionPath,
    },
  });

  const result = await archiveRunnerSessionsForSlotRelease({ vars: localVars, runId: run.id });
  assert.equal(result.captured, 1);
});

test('evicting a run deletes its session archive directory', async (t) => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'fs-session-archive-evict-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const sessionPath = path.join(tmp, 'session.jsonl');
  await writeFile(sessionPath, `${CLAUDE_LINES.join('\n')}\n`, 'utf8');

  const run = createRun({
    flowType: 'dev',
    mode: 'autonomous',
    project: 'farmslot-farm',
    ticketOrPr: `ARCHIVE-${Date.now()}-evict`,
    runner: 'claude',
  });
  t.after(() => cleanupRun(run.id));
  updateRun(run.id, {
    status: 'done',
    completedAt: new Date().toISOString(),
    metrics: {
      ...run.metrics,
      runner: 'claude',
      runnerSessionPath: sessionPath,
    },
  });
  await archiveRunnerSessionsForSlotRelease({ vars: localVars, runId: run.id });
  const dir = runSessionArchiveDir(run.id);
  assert.equal(existsSync(dir), true);
  assert.equal(await archiveRun(run.id), true);
  assert.equal(existsSync(dir), false);
  assert.equal(getRun(run.id), undefined);
});

test('deleting a run deletes its session archive directory', async (t) => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'fs-session-archive-delete-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const sessionPath = path.join(tmp, 'session.jsonl');
  await writeFile(sessionPath, `${CLAUDE_LINES.join('\n')}\n`, 'utf8');

  const run = createRun({
    flowType: 'dev',
    mode: 'autonomous',
    project: 'farmslot-farm',
    ticketOrPr: `ARCHIVE-${Date.now()}-delete`,
    runner: 'claude',
  });
  t.after(() => cleanupRun(run.id));
  updateRun(run.id, {
    status: 'done',
    completedAt: new Date().toISOString(),
    metrics: {
      ...run.metrics,
      runner: 'claude',
      runnerSessionPath: sessionPath,
    },
  });
  await archiveRunnerSessionsForSlotRelease({ vars: localVars, runId: run.id });
  const dir = runSessionArchiveDir(run.id);
  assert.equal(existsSync(dir), true);
  assert.equal(await deleteRun(run.id), true);
  assert.equal(existsSync(dir), false);
});

test('does not copy transcripts for runners that declare sessionArchive none', async (t) => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'fs-session-archive-cursor-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const sessionPath = path.join(tmp, 'not-a-session.jsonl');
  await writeFile(sessionPath, 'nope\n', 'utf8');

  const run = createRun({
    flowType: 'dev',
    mode: 'autonomous',
    project: 'farmslot-farm',
    ticketOrPr: `ARCHIVE-${Date.now()}-cursor`,
    runner: 'cursor',
  });
  t.after(() => cleanupRun(run.id));
  updateRun(run.id, {
    metrics: {
      ...run.metrics,
      runner: 'cursor',
      runnerSessionPath: sessionPath,
    },
  });

  const result = await archiveRunnerSessionsForSlotRelease({ vars: localVars, runId: run.id });
  assert.equal(result.captured, 0);
  assert.equal(getRun(run.id)?.metrics.runnerSessionArchive?.status, 'unsupported');
});
