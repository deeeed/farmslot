import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { mock, test } from 'node:test';

import type { AgentContext, RunReviewResult } from '@farmslot/protocol';

const github = await import('../external/github.js');
mock.module('../external/github.js', {
  namedExports: { ...github, isGitHubAncestor: async () => true },
});
const store = await import('../runs/store.js');
const { archiveRun, createRun, deleteArchivedRun, deleteRun, getRun, runsDirectory, updateRun } =
  store;
const { handleRepeatReviewDecision } = await import('./engine-decisions.js');

const head = 'a'.repeat(40);
const result: RunReviewResult = {
  recommendation: 'pass',
  reviewMd: 'Review complete.',
  lineComments: [],
  reviewSnapshot: { source: 'github-pr', headSha: head, capturedAt: '2026-11-12T00:00:00Z' },
};

for (const mode of ['warm', 'cold', 'fresh'] as const) {
  test(`a new ${mode} review handles archived history without restoring it`, async (t) => {
    const prior = createRun({
      flowType: 'review-pr',
      project: 'history',
      ticketOrPr: 'owner/repo#42',
    });
    const reviewer: AgentContext = {
      id: 'review',
      role: 'review',
      label: 'Review',
      runId: prior.id,
      slotId: 'review-slot',
      status: 'complete',
      reviewId: 'lineage',
      runner: 'codex',
      runnerSessionId: 'retained-session',
      runnerSessionPath: '/fixture/session.jsonl',
    };
    updateRun(prior.id, {
      status: 'done',
      completedAt: '2026-11-12T00:00:00Z',
      reviewResult: result,
      agentContexts: [reviewer],
    });
    await archiveRun(prior.id);
    t.after(() => deleteArchivedRun(prior.id));
    const archive = path.join(runsDirectory(), 'archive', `${prior.id}.json`);
    const before = await readFile(archive);
    const current = createRun({
      flowType: 'review-pr',
      project: prior.project,
      ticketOrPr: prior.ticketOrPr,
      reviewMode: mode === 'warm' ? 'warm' : 'cold',
      reviewContext: {
        ...(mode === 'fresh' ? { freshChain: true } : {}),
        reviewLineages:
          mode === 'fresh'
            ? [null]
            : [{ reviewId: 'lineage', repository: 'owner/repo', prNumber: 42 }],
      },
    });
    t.after(async () => {
      updateRun(current.id, { status: 'done' });
      await deleteRun(current.id);
    });
    const selected = await handleRepeatReviewDecision(current.id, current, {
      repository: 'owner/repo',
      prNumber: 42,
      headSha: 'b'.repeat(40),
    });
    if (mode === 'fresh') assert.equal(selected, null);
    else {
      assert.equal(selected?.priorRunId, prior.id);
      assert.equal(selected?.session?.reviewId, 'lineage');
      assert.equal(selected?.priorReviewedHeadSha, head);
      assert.equal(selected?.mode, mode);
    }
    assert.equal(getRun(prior.id), undefined);
    assert.deepEqual(await readFile(archive), before);
  });
}
