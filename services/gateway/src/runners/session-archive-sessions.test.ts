import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { mock, type TestContext } from 'node:test';

import type { AgentContext, Run } from '@farmslot/protocol';

const slotIo = await import('../core/slot-io.js');
/** A copy the test holds open or fails, to prove queueing, bounds and atomic replacement. */
let copyGate: Promise<void> | undefined;
let failCopy = false;
mock.module('../core/slot-io.js', {
  namedExports: {
    ...slotIo,
    slotCopyFile: async (...args: Parameters<typeof slotIo.slotCopyFile>) => {
      if (copyGate) await copyGate;
      if (failCopy) {
        await writeFile(args[2], 'partial');
        throw new Error('node went away mid-copy');
      }
      return slotIo.slotCopyFile(...args);
    },
  },
});
const { createRun, deleteRun, getRun, runSessionArchiveDir, updateRun } =
  await import('../runs/store.js');
const {
  archiveRunnerSessionsForSlotRelease,
  captureRunnerSession,
  captureRunnerSessionBeforeReplay,
  readRunnerSessionArchiveLines,
  runnerSessionArchiveContextDir,
} = await import('./session-archive.js');

const vars = { host: 'localhost', machine: 'test', sshTarget: 'localhost' };
const line = (text: string) =>
  `${JSON.stringify({ uuid: text, type: 'assistant', message: { content: [{ type: 'text', text }] } })}\n`;

async function fixture(t: TestContext) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'fs-session-archive-sessions-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const run = createRun({
    flowType: 'review-pr',
    mode: 'autonomous',
    project: 'farmslot-farm',
    ticketOrPr: `owner/repo#${Date.now()}${Math.floor(Math.random() * 1000)}`,
    runner: 'claude',
  });
  t.after(async () => {
    copyGate = undefined;
    failCopy = false;
    if (!getRun(run.id)) return;
    updateRun(run.id, { status: 'done', completedAt: new Date().toISOString() });
    await deleteRun(run.id);
  });
  /** Point a context at a (new) runner session, as a review round or replay does. */
  const session = async (contextId: string, sessionId: string, text = sessionId) => {
    const file = path.join(tmp, `${contextId}-${sessionId}.jsonl`);
    await writeFile(file, line(text));
    const context: AgentContext = {
      id: contextId,
      role: contextId === 'review-fix' ? 'review-fix' : 'review',
      label: contextId,
      status: 'complete',
      runId: run.id,
      slotId: null,
      runner: 'claude',
      runnerSessionId: sessionId,
      runnerSessionPath: file,
    };
    // A new session patches the context, as the runners do; its archive lists stay.
    const contexts = getRun(run.id)!.agentContexts ?? [];
    const prior = contexts.find((c) => c.id === contextId);
    updateRun(run.id, {
      agentContexts: prior
        ? contexts.map((c) =>
            c.id === contextId
              ? {
                  ...c,
                  ...context,
                  runnerSessionArchives: c.runnerSessionArchives,
                  runnerSessionArchive: c.runnerSessionArchive,
                }
              : c,
          )
        : [...contexts, context],
    });
    return file;
  };
  const archives = (contextId: string) =>
    getRun(run.id)!.agentContexts!.find((c) => c.id === contextId)!;
  return { run, session, archives };
}

test('each session of a context reused across rounds keeps its own archive', async (t) => {
  const { run, session, archives } = await fixture(t);
  await session('review', 'round-1');
  await captureRunnerSession({ vars, runId: run.id, contextId: 'review' });
  await session('review', 'round-2');
  await captureRunnerSession({ vars, runId: run.id, contextId: 'review' });

  const context = archives('review');
  assert.deepEqual(
    context.runnerSessionArchives?.map((ref) => [ref.sessionKey, ref.status]),
    [
      ['round-1', 'captured'],
      ['round-2', 'captured'],
    ],
  );
  // The single ref History and usage read is the latest session.
  assert.equal(context.runnerSessionArchive?.sessionKey, 'round-2');
  for (const key of ['round-1', 'round-2']) {
    const file = path.join(
      runnerSessionArchiveContextDir(run.id, 'review'),
      key,
      'transcript.jsonl',
    );
    assert.equal(await readFile(file, 'utf8'), line(key));
  }
  const read = await readRunnerSessionArchiveLines({ run: getRun(run.id)!, contextId: 'review' });
  assert.equal(read?.lines[0], line('round-2').trim());
});

test('a review-fix ref records the round it answers', async (t) => {
  const { run, session, archives } = await fixture(t);
  await session('review-fix', 'fix-1');
  await captureRunnerSession({ vars, runId: run.id, contextId: 'review-fix', answersRound: 1 });
  assert.equal(archives('review-fix').runnerSessionArchives?.[0]?.answersRound, 1);
});

test('a failed copy never removes the transcript captured before it', async (t) => {
  const { run, session, archives } = await fixture(t);
  const file = await session('review', 'round-1');
  await captureRunnerSession({ vars, runId: run.id, contextId: 'review' });
  const captured = archives('review').runnerSessionArchive!;
  await appendFile(file, line('more'));
  failCopy = true;
  await captureRunnerSession({ vars, runId: run.id, contextId: 'review' });

  const dir = path.join(runnerSessionArchiveContextDir(run.id, 'review'), 'round-1');
  assert.equal(await readFile(path.join(dir, 'transcript.jsonl'), 'utf8'), line('round-1'));
  const after = archives('review').runnerSessionArchive!;
  assert.equal(after.status, 'captured');
  assert.equal(after.sha256, captured.sha256);
  assert.ok(after.lastAttemptAt);
});

test('an unchanged source is not copied again', async (t) => {
  const { run, session, archives } = await fixture(t);
  await session('review', 'round-1');
  await captureRunnerSession({ vars, runId: run.id, contextId: 'review' });
  const first = archives('review').runnerSessionArchive!;
  await captureRunnerSession({ vars, runId: run.id, contextId: 'review' });
  assert.equal(archives('review').runnerSessionArchive!.capturedAt, first.capturedAt);
});

test('captures for one run run one after another and none overwrites another', async (t) => {
  const { run, session, archives } = await fixture(t);
  await session('review', 'round-1');
  await session('review-fix', 'fix-1');
  let release!: () => void;
  copyGate = new Promise((resolve) => (release = resolve));
  const both = Promise.all([
    captureRunnerSession({ vars, runId: run.id, contextId: 'review' }),
    captureRunnerSession({ vars, runId: run.id, contextId: 'review-fix', answersRound: 1 }),
  ]);
  release();
  await both;
  assert.equal(archives('review').runnerSessionArchive?.status, 'captured');
  assert.equal(archives('review-fix').runnerSessionArchive?.status, 'captured');
});

test('a pre-replay capture past its bound records missing and a late copy still lands', async (t) => {
  const { run, session, archives } = await fixture(t);
  await session('review', 'round-1');
  let release!: () => void;
  copyGate = new Promise((resolve) => (release = resolve));
  const ref = await captureRunnerSessionBeforeReplay({
    vars,
    runId: run.id,
    contextId: 'review',
    timeoutMs: 20,
  });
  assert.equal(ref?.status, 'missing');
  assert.equal(ref?.reason, 'capture-timeout');
  release();
  await archiveRunnerSessionsForSlotRelease({ vars, runId: run.id });
  assert.equal(archives('review').runnerSessionArchive?.status, 'captured');
});

test('a retried missing capture keeps its first reason', async (t) => {
  const { run, session, archives } = await fixture(t);
  const file = await session('review', 'round-1');
  await rm(file);
  await captureRunnerSession({ vars, runId: run.id, contextId: 'review' });
  const first = archives('review').runnerSessionArchive!;
  assert.equal(first.status, 'missing');
  await captureRunnerSession({ vars, runId: run.id, contextId: 'review' });
  const retried = archives('review').runnerSessionArchive!;
  assert.equal(retried.reason, first.reason);
  assert.ok(retried.lastAttemptAt);
});

test('a legacy archive reads as one session and is not moved', async (t) => {
  const { run, session } = await fixture(t);
  await session('review', 'old');
  const legacyDir = runnerSessionArchiveContextDir(run.id, 'review');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(legacyDir, { recursive: true });
  await writeFile(path.join(legacyDir, 'transcript.jsonl'), line('legacy'));
  const current = getRun(run.id) as Run;
  updateRun(run.id, {
    agentContexts: current.agentContexts!.map((c) => ({
      ...c,
      runnerSessionArchive: { status: 'captured', originalPath: '/old/path.jsonl' },
    })),
  });
  const read = await readRunnerSessionArchiveLines({ run: getRun(run.id)!, contextId: 'review' });
  assert.equal(read?.lines[0], line('legacy').trim());
  assert.ok(existsSync(path.join(legacyDir, 'transcript.jsonl')));
  assert.ok(runSessionArchiveDir(run.id));
});
