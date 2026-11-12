import assert from 'node:assert/strict';
import test from 'node:test';

import { type Run, runListRow, trimRunForList } from '@farmslot/protocol';

import { nativeWorkerTabs } from '../src/native-worker-target.js';
import { runActivityView, runReviewActivityContext } from '../src/run-activity.js';
import { runRecoveredReviewFailures } from '../src/run-review-failures.js';

/** A run in its second review attempt on a native reviewer, after a failed first attempt. */
function reviewingRun(): Run {
  const context = {
    label: 'Reviewer',
    role: 'review' as const,
    slotId: 'slot-4',
    runId: 'native-run',
    runner: 'claude',
    reviewId: 'rev-1',
    reviewLoopNumber: 1,
    runnerSessionPath: '/home/worker/.claude/session.jsonl',
    usage: {
      totalTokens: 9000,
      measuredAt: '2026-11-01T00:06:00.000Z',
      source: 'runner-transcript' as const,
    },
    runnerSessionArchive: { status: 'captured' as const, relativeDir: 'session-archives/native' },
  };
  return {
    id: 'native-run',
    familyId: 'family-native',
    lane: 'production',
    flowType: 'fix-bug',
    status: 'reviewing',
    project: 'demo',
    ticketOrPr: 'TEAM-9',
    slotId: 'slot-4',
    branch: 'fix/native',
    taskFile: '/repo/tasks/TASK.md',
    steps: [
      { name: 'monitor', status: 'done' },
      { name: 'review', status: 'running', startedAt: '2026-11-01T00:05:00.000Z' },
    ],
    decisions: [],
    agentContexts: [
      {
        ...context,
        id: 'review-1',
        status: 'failed',
        error: 'Reviewer crashed',
        startedAt: '2026-11-01T00:02:00.000Z',
      },
      {
        ...context,
        id: 'review-2',
        status: 'working',
        startedAt: '2026-11-01T00:05:00.000Z',
        nativeSession: {
          sessionId: 'session-2',
          executionNodeId: 'node-1',
          ownerPrincipalId: 'operator',
          leaseId: 'lease-2',
          commandId: 'command-2',
          generation: 'g2',
          effort: 'high',
        },
      },
    ],
    metrics: { nudgeCount: 0, model: null, runner: null },
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:06:00.000Z',
  };
}

// Run activity, the recovered-review segment and split view's native tabs read agent contexts:
// the same from the served row, the full run and an old cached row.
test('agent-context readers agree on the served row, the full run and an old cached row', () => {
  const full = reviewingRun();
  const views = (run: Parameters<typeof runActivityView>[0]) => ({
    activity: runActivityView(run)?.label,
    reviewer: runReviewActivityContext(run)?.id,
    recovered: runRecoveredReviewFailures(run).map(({ name, reason }) => [name, reason]),
    tabs: nativeWorkerTabs(run.agentContexts ?? [], 'slot-4').map(({ key, label }) => [key, label]),
  });
  const expected = views(full);
  assert.equal(expected.reviewer, 'review-2');
  assert.deepEqual(expected.recovered, [['recovered-review-review-1', 'Reviewer crashed']]);
  assert.equal(expected.tabs.length, 1);
  const row = runListRow(full);
  assert.equal(row.detailTrimmed, true);
  assert.deepEqual(views(row), expected);
  assert.deepEqual(views(trimRunForList(full)), expected);
});
