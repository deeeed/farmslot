import assert from 'node:assert/strict';
import test from 'node:test';

import type { Run } from '@farmslot/protocol';

import { runRecoveredReviewFailures } from '../src/run-review-failures.js';

test('a failed reviewer followed by a replacement keeps its actual failure reason in both mini bars', () => {
  const run: Run = {
    id: 'run',
    familyId: 'run',
    parentRunId: null,
    familyRootTicketOrPr: 'TEST',
    flowType: 'dev',
    lane: 'production',
    variant: null,
    mode: 'autonomous',
    status: 'human-gating',
    project: 'fixture',
    ticketOrPr: 'TEST',
    slotId: 'slot',
    branch: 'feature',
    taskFile: 'temp/task/TASK.md',
    steps: [],
    decisions: [],
    metrics: { nudgeCount: 0, runner: 'codex', model: 'gpt-6.1-sol' },
    createdAt: '2026-10-21T10:00:00Z',
    updatedAt: '2026-10-21T10:31:00Z',
    agentContexts: [
      {
        id: 'failed',
        role: 'review',
        label: 'Reviewer',
        status: 'failed',
        runId: 'run',
        slotId: 'slot',
        reviewId: 'review',
        reviewLoopNumber: 3,
        startedAt: '2026-10-21T10:04:43Z',
        completedAt: '2026-10-21T10:05:27Z',
      },
      {
        id: 'replacement',
        role: 'review',
        label: 'Reviewer',
        status: 'complete',
        runId: 'run',
        slotId: 'slot',
        reviewId: 'review',
        reviewLoopNumber: 3,
        startedAt: '2026-10-21T10:04:43Z',
        completedAt: '2026-10-21T10:31:00Z',
        reviewFallback: {
          reason: 'session-unavailable',
          detail: 'Native worker launch configuration changed; explicit recovery is required',
          comparedRanges: ['old..new'],
        },
      },
    ],
  };
  const [warning] = runRecoveredReviewFailures(run);
  assert.match(warning.reason, /launch configuration changed/);
  assert.equal(warning.outputs?.recoveredReviewFailure, true);
  assert.equal(run.status, 'human-gating');
  run.agentContexts = run.agentContexts?.slice(0, 1);
  assert.deepEqual(
    runRecoveredReviewFailures(run),
    [],
    'a stopped failure is not a recovered attempt',
  );
});
