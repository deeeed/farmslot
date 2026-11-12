import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

const github = await import('../external/github.js');
mock.module('../external/github.js', {
  namedExports: { ...github, isGitHubAncestor: async () => true },
});
const { createRun, deleteRun, getRun, updateRun } = await import('../runs/store.js');
const { handleRepeatReviewDecision, buildRepeatReviewContext } =
  await import('./engine-decisions.js');
const { buildReviewExecutionContract, writePreviousReviewInputs } =
  await import('../tasks/writer.js');

for (const cached of [false, true]) {
  test(`unsupported fallback is frozen before task generation, cached=${cached}`, async (t) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'review-fallback-task-'));
    await mkdir(path.join(dir, 'inputs'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const prior = createRun({
      flowType: 'review-pr',
      project: 'fallback-task',
      ticketOrPr: 'owner/repo#42',
      slotId: 'slot',
      runner: 'opencode',
      model: 'auto',
      transport: 'tmux',
    });
    updateRun(prior.id, {
      status: 'done',
      reviewResult: {
        recommendation: 'REQUEST_CHANGES',
        reviewMd: 'Prior finding',
        lineComments: [{ path: 'src/a.ts', line: 1, body: 'Prior finding', severity: 'major' }],
        reviewSnapshot: {
          source: 'github-pr',
          headSha: 'a'.repeat(40),
          capturedAt: new Date().toISOString(),
        },
      },
      agentContexts: [
        {
          id: 'review',
          role: 'review',
          label: 'Review',
          status: 'complete',
          runId: prior.id,
          slotId: 'slot',
          runner: 'opencode',
          model: 'auto',
          reviewId: 'lineage',
          updatedAt: new Date().toISOString(),
        },
      ],
    });
    const run = createRun({
      flowType: 'review-pr',
      project: prior.project,
      ticketOrPr: prior.ticketOrPr,
      slotId: 'slot',
      runner: 'opencode',
      model: 'auto',
      transport: 'tmux',
      reviewMode: 'warm',
      reviewContext: {
        reviewLineages: [{ reviewId: 'lineage', repository: 'owner/repo', prNumber: 42 }],
      },
    });
    t.after(async () => {
      for (const id of [run.id, prior.id]) {
        updateRun(id, { status: 'done' });
        await deleteRun(id);
      }
    });
    if (cached)
      updateRun(run.id, {
        repeatReviewContext: buildRepeatReviewContext(
          run,
          getRun(prior.id)!,
          {
            project: prior.project,
            repository: 'owner/repo',
            prNumber: 42,
            headSha: 'b'.repeat(40),
          },
          [getRun(prior.id)!],
        ),
      });
    await handleRepeatReviewDecision(run.id, run, {
      repository: 'owner/repo',
      prNumber: 42,
      headSha: 'b'.repeat(40),
    });
    const frozen = getRun(run.id)!;
    assert.equal(frozen.reviewMode, 'cold');
    assert.equal(
      frozen.repeatReviewContext?.session?.fallback?.reason,
      'session-resume-unsupported',
    );
    const inputs = await writePreviousReviewInputs(dir, frozen);
    assert.equal(inputs.length, 2);
    const contract = buildReviewExecutionContract(frozen, inputs, []);
    assert(contract.includes(`${'a'.repeat(40)}..${'b'.repeat(40)}`));
    assert(contract.includes('fresh reviewer context'));
    assert(!contract.includes('refuse if the verified session cannot be resumed'));
    const previous = await readFile(path.join(dir, 'inputs/previous-review.md'), 'utf8');
    assert(previous.includes('Prior finding'));
  });
}
