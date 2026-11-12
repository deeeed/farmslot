import assert from 'node:assert/strict';
import test from 'node:test';

import {
  deriveRunLifecycleView,
  runDisplayStatus,
} from '../../src/contracts/run-lifecycle-view.js';
import type { Run } from '../../src/contracts/runs.js';
import { runLinkedTicketRefs, runLinkedTicketsView } from '../../src/runs/linked-tickets.js';
import { runListRow, trimRunForList } from '../../src/runs/list-trim.js';
import { savedReviewExpected } from '../../src/runs/review-chain.js';
import { reviewRoundBudgetForRun } from '../../src/runs/review-retries.js';
import { runListProjection } from '../../src/runs/run-list-filter.js';
import { resolveRunSlotId } from '../../src/runs/slot-resolution.js';

/** A review run carrying the heavy agent-context, metrics, ticket and review keys a row leaves out. */
function reviewRun(): Run {
  return {
    id: 'review-run',
    familyId: 'family-review',
    lane: 'production',
    flowType: 'review-pr',
    status: 'done',
    project: 'demo',
    ticketOrPr: 'TEAM-7',
    summary: 'Review the banner fix',
    slotId: null,
    branch: 'review/banner',
    taskFile: '/repo/tasks/TASK.md',
    links: [{ label: 'PR', url: 'https://github.com/owner/repo/pull/7' }],
    steps: [
      { name: 'find-slot', status: 'done', outputs: { selectedSlot: 'slot-3' } },
      { name: 'review', status: 'done' },
    ],
    decisions: [],
    agentContexts: [
      {
        id: 'review',
        label: 'Reviewer',
        role: 'review',
        status: 'complete',
        slotId: 'slot-3',
        runId: 'review-run',
        runner: 'codex',
        reviewId: 'rev-1',
        reviewLoopNumber: 1,
        artifactScope: 'rev-1',
        reviewResultValidatedAt: '2026-11-01T00:10:00.000Z',
        startedAt: '2026-11-01T00:01:00.000Z',
        completedAt: '2026-11-01T00:10:00.000Z',
        runnerSessionPath: '/home/worker/.codex/session.jsonl',
        usage: {
          totalTokens: 9000,
          measuredAt: '2026-11-01T00:10:00.000Z',
          source: 'runner-transcript',
        },
        runnerSessionArchive: { status: 'captured', relativeDir: 'session-archives/review-run' },
      },
    ],
    reviewRoundAdmissions: ['rev-1'],
    reviewRoundSettlements: {},
    metrics: {
      nudgeCount: 0,
      model: 'gpt-6',
      runner: 'codex',
      durationMs: 540_000,
      outcome: 'success',
      runnerSessionId: 'session-9',
      checklistTiming: {
        schemaVersion: 1,
        events: [{ stepNumber: 1, label: 'Read', checkedAt: '2026-11-01T00:02:00.000Z' }],
      },
    },
    ticketData: {
      source: 'jira',
      title: 'Banner missing',
      description: 'd'.repeat(2000),
      acceptanceCriteria: ['Banner shows'],
      affectedArea: 'home',
      stepsToReproduce: ['Open home'],
      screenshots: [],
      labels: [],
      jiraKey: 'TEAM-7',
      linkedTickets: [
        {
          ref: 'TEAM-8',
          url: 'https://jira.example/browse/TEAM-8',
          title: 'Related',
          description: 'l'.repeat(800),
          source: 'jira',
        },
      ],
    },
    reviewResult: { recommendation: 'APPROVE', reviewMd: 'r'.repeat(3000), lineComments: [] },
    reviewWorkspaceSubject: {
      repository: 'owner/repo',
      repositoryUrl: 'https://github.com/owner/repo',
      headSha: 'a'.repeat(40),
      baseSha: 'b'.repeat(40),
      branch: 'review/banner',
      title: 'Banner missing',
      body: 'b'.repeat(2000),
      capturedAt: '2026-11-01T00:00:30.000Z',
    },
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:11:00.000Z',
  };
}

// Each protocol list reader of agent contexts, the ticket, metrics, the review result and the
// review subject reads the same from the row the gateway serves, the full run and a row cached
// before slim rows.
test('list readers of agent contexts, tickets, metrics and review results agree on the served row', () => {
  const full = reviewRun();
  const views = (run: Parameters<typeof runListProjection>[0]) => ({
    slot: resolveRunSlotId(run),
    ticketRefs: runLinkedTicketRefs(run),
    tickets: runLinkedTicketsView(run),
    savedReview: savedReviewExpected(run),
    budget: reviewRoundBudgetForRun(run),
    projection: runListProjection(run),
    status: runDisplayStatus(run),
    lifecycle: deriveRunLifecycleView(run),
  });
  const expected = views(full);
  assert.equal(expected.slot, 'slot-3');
  assert.deepEqual(expected.ticketRefs, ['TEAM-7', 'TEAM-8']);
  assert.equal(expected.savedReview, true);
  const row = runListRow(full);
  assert.equal(row.detailTrimmed, true);
  assert.deepEqual(views(row), expected);
  assert.deepEqual(views(trimRunForList(full)), expected);
});
