import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { listProcesses } from '../lib/isolated-stack.mjs';

export async function runScenario(c) {
  await c.start();
  let worker;
  for (let round = 1; round <= 4; round++) {
    const reviewed = await c.wait(`review round ${round} returns findings`, async (run) => {
      await c.answer(run, true);
      return (
        run.reviewRoundAdmissions?.length === round &&
        run.status === 'blocked' &&
        run.decisions.some(
          (decision) => !decision.resolvedAt && decision.type === 'engine_review_complete',
        )
      );
    });
    if (round === 1) {
      worker = listProcesses().find((process) => {
        const executable = process.command.split(' ')[0];
        return (
          (executable === 'node' || executable.endsWith('/node')) &&
          process.command.includes(path.join(c.repo, 'packages/cli/bin/farmslot.mjs'))
        );
      });
      assert.ok(worker, 'the scripted worker is alive before the budget stop');
    }
    const decision = reviewed.decisions.find(
      (decision) => !decision.resolvedAt && decision.type === 'engine_review_complete',
    );
    await c.resolve(decision, 'skip');
    await c.wait(
      `review round ${round} reaches gate`,
      (run) =>
        run.steps.find((step) => step.name === 'review')?.status === 'done' &&
        run.decisions.some(
          (decision) => !decision.resolvedAt && decision.type === 'engine_human_gate',
        ),
    );
    await c.replay('review');
  }
  const headSha = c.git('rev-parse', 'HEAD');
  const branch = c.git('branch', '--show-current');
  const capped = await c.wait(
    'round five retains the result for an operator decision',
    async (run) => {
      await c.answer(run, true);
      return run.reviewRoundAdmissions?.length === 5 && run.status === 'needs-decision';
    },
  );
  const review = capped.steps.find((step) => step.name === 'review');
  assert.equal(review?.status, 'failed');
  assert.equal(review.outputs?.verdict, 'issues');
  assert.equal(review.outputs?.reviewLaunchRejection?.code, 'REVIEW_ROUND_LIMIT_REACHED');
  assert.equal(review.outputs.reviewLaunchRejection.details.reviewRoundBudget.remaining, 0);
  const decision = capped.decisions.find((decision) => !decision.resolvedAt);
  assert.equal(decision?.type, 'engine_result_decision');
  assert.equal(decision.payload?.kind, 'result-decision');
  assert.equal(decision.payload.stoppedAt, 'review');
  const assertRetained = async (run) => {
    assert.equal(run.status, 'needs-decision');
    assert.equal(run.slotId, c.slotId);
    assert.equal(c.git('rev-parse', 'HEAD'), headSha);
    assert.equal(c.git('branch', '--show-current'), branch);
    assert.ok(
      listProcesses().some(
        (process) => process.pid === worker.pid && process.command === worker.command,
      ),
      'the same scripted worker is retained',
    );
    const lease = JSON.parse(
      await readFile(path.join(c.stack.fixture, '.farm-status.json'), 'utf8'),
    ).slots.find((slot) => slot.slot === c.slotId);
    assert.equal(lease?.current_run_id, run.id);
    return lease;
  };
  const lease = await assertRetained(capped);
  await writeFile(
    path.join(c.dir, 'retained-hold.json'),
    JSON.stringify({ run: capped, worker, lease, headSha, branch }, null, 2),
  );
  const grant = await c.call('run.extendReviewBudget', {
    runId: capped.id,
    slotId: c.slotId,
    requestId: 'round-six',
    expectedLimit: 5,
    limit: 6,
    headSha,
    scopeBrief: 'One further static review of the fixture revision.',
  });
  assert.equal(grant.budget.remaining, 1);
  await assertRetained(await c.get());
  await c.replay('review');
  const recovered = await c.wait('round six completes', async (run) => {
    await c.answer(run, false);
    return (
      run.reviewRoundAdmissions?.length === 6 &&
      run.steps.find((step) => step.name === 'review')?.status === 'done'
    );
  });
  assert.equal(recovered.reviewRoundAdmissions.length, 6);
  assert.equal(recovered.steps.find((step) => step.name === 'review').outputs?.verdict, 'pass');
}
