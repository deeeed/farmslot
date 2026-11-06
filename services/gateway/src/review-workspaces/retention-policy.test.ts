import assert from 'node:assert/strict';
import test from 'node:test';

import type { Run } from '@farmslot/protocol';

import {
  retainedWorkspaceIsIdle,
  reviewWorkspaceExpiry,
  sameReviewPR,
  workspaceRetentionProtected,
} from './retention-policy.js';
const ended = '2026-11-01T00:00:00.000Z';
const workspace = {
  workspaceId: 'workspace',
  machine: 'node',
  executionNodeId: 'node',
  checkoutPath: '/owned/runs/workspace/source',
  taskPath: '/owned/runs/workspace/task',
  artifactPath: '/owned/runs/workspace/task/artifacts',
};
test('retention defaults to seven days and freezes an explicit two-day deadline', () => {
  assert.equal(
    reviewWorkspaceExpiry({ reviewWorkspace: workspace, completedAt: ended }),
    '2026-11-08T00:00:00.000Z',
  );
  assert.equal(
    reviewWorkspaceExpiry({
      reviewWorkspace: { ...workspace, retentionDays: 2 },
      completedAt: ended,
    }),
    '2026-11-03T00:00:00.000Z',
  );
  assert.equal(
    reviewWorkspaceExpiry({
      reviewWorkspace: { ...workspace, retainedUntil: '2026-11-04T00:00:00.000Z' },
      completedAt: ended,
    }),
    '2026-11-04T00:00:00.000Z',
  );
  assert.equal(reviewWorkspaceExpiry({ reviewWorkspace: workspace }), null);
});
test('PR protection uses exact repository and number, independent of project or display casing', () => {
  assert.equal(
    sameReviewPR(
      { ticketOrPr: 'Example/App#42' },
      { ticketOrPr: 'https://github.com/example/app/pull/42' },
    ),
    true,
  );
  assert.equal(
    sameReviewPR({ ticketOrPr: 'Example/App#42' }, { ticketOrPr: 'Example/other#42' }),
    false,
  );
  assert.equal(
    sameReviewPR({ ticketOrPr: 'Example/App#42' }, { ticketOrPr: 'Example/App#420' }),
    false,
  );
});
test('only stopped terminal retained reviews release active machine capacity', () => {
  const run: Pick<Run, 'status' | 'reviewWorkspace' | 'agentContexts'> = {
    status: 'done',
    reviewWorkspace: { ...workspace, retainedAt: ended },
    agentContexts: [],
  };
  assert.equal(retainedWorkspaceIsIdle(run), true);
  assert.equal(retainedWorkspaceIsIdle({ ...run, status: 'monitoring' }), false);
  assert.equal(retainedWorkspaceIsIdle({ ...run, reviewWorkspace: workspace }), false);
  assert.equal(
    retainedWorkspaceIsIdle({
      ...run,
      agentContexts: [
        {
          id: 'review',
          role: 'review',
          label: 'Reviewer',
          runId: 'run',
          slotId: null,
          status: 'working',
        },
      ],
    }),
    false,
  );
});

test('active/pending PR reviews and unresolved posting gates protect expiry cleanup', () => {
  const target = { ticketOrPr: 'example/app#42' };
  const done: Pick<Run, 'ticketOrPr' | 'status' | 'decisions'> = {
    ...target,
    status: 'done',
    decisions: [],
  };
  assert.equal(workspaceRetentionProtected(target, [done], []), false);
  assert.equal(workspaceRetentionProtected(target, [{ ...done, status: 'monitoring' }], []), true);
  assert.equal(
    workspaceRetentionProtected(
      target,
      [{ ...done, ticketOrPr: 'other/app#42', status: 'monitoring' }],
      [],
    ),
    false,
  );
  assert.equal(workspaceRetentionProtected(target, [done], [target]), true);
  assert.equal(
    workspaceRetentionProtected(
      target,
      [
        {
          ...done,
          decisions: [
            {
              id: 'posting',
              type: 'engine_review_posting',
              title: 'Post',
              description: 'Pending review',
              actions: [],
              createdAt: ended,
            },
          ],
        },
      ],
      [],
    ),
    true,
  );
  assert.equal(workspaceRetentionProtected({ ticketOrPr: 'unknown' }, [], []), true);
});
