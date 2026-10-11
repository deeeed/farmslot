import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { executionModelFromSelection } from '@farmslot/review-dispatch';

import { makeRun } from '../run-engine/test-fixtures.js';
import * as store from '../runs/store.js';

const selection = { runner: 'codex', model: null, effort: null, mode: 'warm' as const };
const execution = executionModelFromSelection(selection);
const run = {
  ...makeRun({
    project: 'default-effort',
    flowType: 'review-pr',
    ticketOrPr: 'owner/repo#42',
  }),
  transport: 'native' as const,
};
let deliveredEffort: string | null | undefined;
mock.module('../runs/store.js', { namedExports: { ...store, getRun: () => run } });
mock.module('./native-review-agent.js', {
  namedExports: {
    runNativeReviewAgent: async (input: { effort?: string | null }) => {
      deliveredEffort = input.effort;
      return { verdict: 'pass', issues: [] };
    },
  },
});
const { runReviewAgent } = await import('./review-agent.js');
const { assertWarmReviewRequestAvailable } = await import('../run-engine/review-plan.js');
const { registerWarmReviewerSession, resetWarmReviewerSessionsForTest } =
  await import('./session-mode.js');

test('WARM runner-default effort agrees at gate preflight and reviewer delivery', async () => {
  resetWarmReviewerSessionsForTest();
  registerWarmReviewerSession({
    ...execution,
    runId: run.id,
    reviewId: 'review-default',
    project: run.project,
    ownerPrincipalId: run.nativeOwnerPrincipalId ?? run.createdByPrincipalId ?? null,
    transport: 'native',
    taskDir: '/tmp/review',
    artifactScope: 'review-default',
    repository: 'owner/repo',
    prNumber: 42,
    contextId: 'review-context',
    windowName: 'review-context',
    slotId: 'review-slot',
    runnerSessionId: 'retained-session',
    runnerSessionPath: null,
    lastLoopNumber: 1,
    lastReviewedHeadSha: 'prior-head',
  });
  assert.doesNotThrow(() =>
    assertWarmReviewRequestAvailable(
      run,
      {
        ...selection,
        context: {
          reviewLineages: [{ repository: 'owner/repo', prNumber: 42, reviewId: 'review-default' }],
        },
      },
      [run],
    ),
  );
  await runReviewAgent(
    {} as Parameters<typeof runReviewAgent>[0],
    execution.runner,
    execution.model,
    '/tmp/review',
    'review-slot',
    run.id,
    100,
    1,
    'static-code',
    'review-default',
    'warm',
    null,
    'review-default',
  );
  assert.equal(deliveredEffort, execution.effort);
  resetWarmReviewerSessionsForTest();
});
