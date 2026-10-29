import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
import { makeVars } from './test-fixtures.js';

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

test('historical usage projects verified native counters without mutating the run', async (t) => {
  const { projectArchivedRunnerUsage } = await import('../runtime/session-usage.js');
  const run = createRun({
    flowType: 'dev',
    mode: 'interactive',
    project: 'example-browser-farm',
    ticketOrPr: 'usage-proof',
  });
  t.after(async () => {
    updateRun(run.id, { status: 'done' });
    await deleteRun(run.id);
  });
  const dir = runnerSessionArchiveContextDir(run.id, 'dev');
  await mkdir(dir, { recursive: true });
  const raw =
    [
      { type: 'response_item', payload: { type: 'message', role: 'assistant' } },
      {
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: { total_token_usage: { input_tokens: 100, output_tokens: 12, total_tokens: 112 } },
        },
      },
    ]
      .map((line) => JSON.stringify(line))
      .join('\n') + '\n';
  const transcript = path.join(dir, 'transcript.jsonl');
  await writeFile(transcript, raw);
  const ref = {
    status: 'captured' as const,
    kind: 'jsonl' as const,
    runner: 'codex',
    originalPath: '/tmp/retained-native.jsonl',
    sha256: createHash('sha256').update(raw).digest('hex'),
  };
  const current = {
    ...run,
    metrics: { ...run.metrics, runner: 'codex', runnerSessionArchive: ref },
    agentContexts: [
      {
        id: 'dev',
        label: 'Dev',
        slotId: null,
        runId: run.id,
        role: 'dev' as const,
        status: 'complete' as const,
        runner: 'codex',
        runnerSessionArchive: ref,
      },
    ],
  };
  const projected = await projectArchivedRunnerUsage(current);
  assert.equal(projected.metrics.sessionTurns, 1);
  assert.equal(projected.metrics.sessionTotalTokens, 112);
  assert.equal(current.metrics.sessionTurns, undefined);
  await writeFile(transcript, raw + '{}\n');
  const changed = await projectArchivedRunnerUsage(current);
  assert.equal(changed.metrics.sessionTurns, undefined);
  assert.match(changed.metrics.sessionUsageError ?? '', /SHA256/);
});

test('Claude worker rollup recomputes a removed session from its verified archive', async (t) => {
  const { claudeSessionUsageProvider } = await import('./session-usage-provider.js');
  const { extractRunWorkerSessionUsage } = await import('../runtime/session-usage.js');
  const run = createRun({
    flowType: 'dev',
    mode: 'interactive',
    project: 'example-browser-farm',
    ticketOrPr: 'claude-archive-proof',
  });
  t.after(() => cleanupRun(run.id));
  const dir = runnerSessionArchiveContextDir(run.id, 'dev');
  await mkdir(dir, { recursive: true });
  const record = JSON.stringify({
    type: 'assistant',
    message: {
      id: 'one-message',
      model: 'claude-opus-5-5',
      usage: { input_tokens: 2, output_tokens: 4, cache_read_input_tokens: 100 },
    },
  });
  const raw = record + '\n' + record + '\n';
  const transcript = path.join(dir, 'transcript.jsonl');
  await writeFile(transcript, raw);
  const runnerSessionPath = path.join(dir, 'removed.jsonl');
  const ref = {
    status: 'captured' as const,
    kind: 'jsonl' as const,
    runner: 'claude',
    originalPath: runnerSessionPath,
    sha256: createHash('sha256').update(raw).digest('hex'),
  };
  const current = {
    ...run,
    slotId: 'test-slot',
    metrics: { ...run.metrics, runner: 'claude', sessionTurns: 2 },
    agentContexts: [
      {
        id: 'dev',
        label: 'Dev',
        slotId: 'test-slot',
        runId: run.id,
        role: 'dev' as const,
        status: 'complete' as const,
        runner: 'claude',
        runnerSessionArchive: ref,
      },
    ],
  };
  t.mock.method(claudeSessionUsageProvider, 'recoverSessions', async () => [
    { contextId: 'dev', runnerSessionId: 'removed', runnerSessionPath },
  ]);
  const usage = await extractRunWorkerSessionUsage(current, makeVars());
  assert.equal(usage?.turns, 1);
  assert.equal(usage.totalTokens, 106);
  assert.equal(current.metrics.sessionTurns, 2);
  await writeFile(transcript, raw + '{}\n');
  await assert.rejects(extractRunWorkerSessionUsage(current, makeVars()), /SHA256/);
});
