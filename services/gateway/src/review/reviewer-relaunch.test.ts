import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, mock, test } from 'node:test';

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
type NativeInput = Parameters<typeof import('./native-review-agent.js').runNativeReviewAgent>[0];
let current: Run | undefined;
let calls: NativeInput[];
let attempt: (input: NativeInput) => Promise<ReviewAgentResult>;
const stopped = new ReviewerExitedError('review process exited before its terminal signal');
const result: ReviewAgentResult = { verdict: 'pass', issues: [] };
mock.module('../runs/store.js', { namedExports: { ...store, getRun: () => current } });
mock.module('../core/exec.js', {
  namedExports: {
    ...core,
    execOnSlot: async () => assert.fail('a stopped review must not modify its evidence'),
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

for (const error of [
  stopped,
  new TerminalReviewArtifactError('invalid completed report'),
  new Error('process liveness unknown'),
  new AggregateError([stopped, new Error('cleanup refused')]),
]) {
  test(`${error.name} returns the original failure without replacement or evidence writes`, async () => {
    attempt = async () => {
      throw error;
    };
    await assert.rejects(review(), (caught) => caught === error);
    assert.equal(calls.length, 1);
    assert.equal(
      await readFile(path.join(root, 'tasks/review/REVIEW.md'), 'utf8'),
      'partial: tasks/review/REVIEW.md',
    );
    const artifacts = await readdir(
      path.join(root, 'tasks/review/artifacts/pipeline-review-loop-1'),
    );
    assert.equal(
      artifacts.some((name) => name.startsWith('stopped-')),
      false,
    );
  });
}

for (const cancel of [false, true]) {
  test(`${cancel ? 'cancellation' : 'new generation'} preserves the stopped review without relaunch`, async () => {
    attempt = async () => {
      if (cancel) current!.status = 'cancelled';
      else current!.engineState = { generation: 1 };
      throw stopped;
    };
    await assert.rejects(review(), (error) => error === stopped);
    assert.equal(calls.length, 1);
  });
}

test('a successful review returns its result once', async () => {
  attempt = async () => result;
  assert.equal(await review(), result);
  assert.equal(calls.length, 1);
});
