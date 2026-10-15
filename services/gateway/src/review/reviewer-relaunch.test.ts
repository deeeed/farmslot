import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, mock, test } from 'node:test';
import { promisify } from 'node:util';

import { type AgentContext, allocateReviewerContext, type Run } from '@farmslot/protocol';

import type { ReviewAgentResult } from './review-agent.js';
import { ReviewerExitedError, TerminalReviewArtifactError } from './terminal-result.js';

await import('../runtime/mock-pty.test-support.js');
const core = await import('../core/exec.js');
const store = await import('../runs/store.js');
const { makeRun } = await import('../run-engine/test-fixtures.js');
const { makeVars } = await import('../runners/test-fixtures.js');
const root = await mkdtemp(path.join(os.tmpdir(), 'reviewer-relaunch-'));
const vars = makeVars({ remoteRepo: root, repo: root });
const shell = promisify(execFile);
type NativeInput = Parameters<typeof import('./native-review-agent.js').runNativeReviewAgent>[0];
let current: Run | undefined;
let calls: NativeInput[];
let copyFailure: boolean;
let afterCopy: () => void;
let attempt: (input: NativeInput) => Promise<ReviewAgentResult>;
const stopped = new ReviewerExitedError('review process exited before its terminal signal');
const result: ReviewAgentResult = { verdict: 'pass', issues: [] };
mock.module('../runs/store.js', { namedExports: { ...store, getRun: () => current } });
mock.module('../core/exec.js', {
  namedExports: {
    ...core,
    execOnSlot: async (_vars: unknown, command: string) => {
      if (copyFailure) return { exitCode: 1, stdout: '', stderr: 'copy refused' };
      const { stdout, stderr } = await shell('/bin/sh', ['-c', command]);
      afterCopy();
      return { exitCode: 0, stdout, stderr };
    },
  },
});
mock.module('./native-review-agent.js', {
  namedExports: {
    runNativeReviewAgent: async (input: NativeInput) => {
      calls.push(input);
      return attempt(input);
    },
  },
});
const { runReviewAgent, reviewerFeedbackRelPath, reviewerResultRelPath } =
  await import('./review-agent.js');
after(() => rm(root, { recursive: true, force: true }));
beforeEach(async () => {
  await rm(path.join(root, 'tasks'), { recursive: true, force: true });
  calls = [];
  copyFailure = false;
  afterCopy = () => {};
  current = {
    ...makeRun({ status: 'reviewing', engineState: { generation: 0 } }),
    transport: 'native',
  };
  const context: AgentContext = {
    ...allocateReviewerContext({ runId: current.id, runner: 'claude', model: 'opus' }),
    role: 'review',
    runId: current.id,
    slotId: vars.slotId,
    status: 'failed',
    updatedAt: new Date().toISOString(),
    runner: 'claude',
    model: 'opus',
    taskFile: 'tasks/review/REVIEW.md',
    signalFile: 'tasks/review/REVIEW-SIGNAL.json',
  };
  current.agentContexts = [context];
  const files = [
    context.taskFile!,
    context.signalFile!,
    `tasks/review/${reviewerFeedbackRelPath(context.id)}`,
    `tasks/review/${reviewerResultRelPath(context.id)}`,
    'tasks/review/artifacts/pipeline-review-loop-1/review.diff',
    'tasks/review/artifacts/pipeline-review-loop-1/review-diff-stat.json',
  ];
  for (const file of files) {
    const target = path.join(root, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `partial: ${file}`);
  }
});
const review = (timeout = 10_000) =>
  runReviewAgent(
    vars,
    'claude',
    'opus',
    'tasks/review',
    vars.slotId,
    current!.id,
    timeout,
    1,
    'static-code',
  );

test('production review entry relaunches once and preserves the interrupted outputs before overwrite', async () => {
  attempt = async () => {
    if (calls.length === 1) throw stopped;
    const directory = path.join(root, 'tasks/review/artifacts/pipeline-review-loop-1');
    const saved = (await readdir(directory)).filter((name) => name.startsWith('stopped-'));
    assert.equal(saved.length, 1);
    assert.equal(
      await readFile(path.join(directory, saved[0]!, 'review-feedback.md'), 'utf8'),
      `partial: tasks/review/${reviewerFeedbackRelPath(current!.agentContexts![0]!.id)}`,
    );
    assert.equal(
      await readFile(path.join(directory, saved[0]!, 'review.md'), 'utf8'),
      'partial: tasks/review/REVIEW.md',
    );
    assert.equal(
      await readFile(path.join(directory, saved[0]!, 'review.diff'), 'utf8'),
      'partial: tasks/review/artifacts/pipeline-review-loop-1/review.diff',
    );
    return result;
  };
  assert.equal(await review(), result);
  assert.equal(calls.length, 2);
  assert.equal(calls[1]!.runner, calls[0]!.runner);
  assert.equal(calls[1]!.model, calls[0]!.model);
  assert.ok(
    calls[1]!.reviewTimeoutMs > 0 && calls[1]!.reviewTimeoutMs <= calls[0]!.reviewTimeoutMs,
  );
});

test('a second death returns its actual cause without launching a third reviewer', async () => {
  const second = new ReviewerExitedError('second owned reviewer exited: connection lost');
  attempt = async () => {
    throw calls.length === 1 ? stopped : second;
  };
  await assert.rejects(review(), (error) => error === second);
  assert.equal(calls.length, 2);
});

for (const error of [
  new TerminalReviewArtifactError('invalid completed report'),
  new Error('process liveness unknown'),
  new AggregateError([stopped, new Error('cleanup refused')]),
]) {
  test(`${error.name} keeps its existing handling without relaunch`, async () => {
    attempt = async () => {
      throw error;
    };
    await assert.rejects(review(), (caught) => caught === error);
    assert.equal(calls.length, 1);
  });
}

for (const cancel of [false, true]) {
  test(`${cancel ? 'cancellation' : 'new generation'} prevents reviewer relaunch`, async () => {
    attempt = async () => {
      if (cancel) current!.status = 'cancelled';
      else current!.engineState = { generation: 1 };
      throw stopped;
    };
    await assert.rejects(review(), (error) => error === stopped);
    assert.equal(calls.length, 1);
  });
}

test('a failed evidence copy prevents relaunch and retains both failures', async () => {
  copyFailure = true;
  attempt = async () => {
    throw stopped;
  };
  await assert.rejects(
    review(),
    (error) => error instanceof AggregateError && error.errors[0] === stopped,
  );
  assert.equal(calls.length, 1);
});

test('a replay during evidence retention cannot launch a replacement', async () => {
  afterCopy = () => {
    current!.engineState = { generation: 1 };
  };
  attempt = async () => {
    throw stopped;
  };
  await assert.rejects(review(), (error) => error === stopped);
  assert.equal(calls.length, 1);
});

test('an exhausted review deadline fails clearly rather than launching with a clamped timeout', async (t) => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  attempt = async () => {
    now = 1101;
    throw stopped;
  };
  await assert.rejects(review(100), /review deadline expired before relaunch/);
  assert.equal(calls.length, 1);
});
