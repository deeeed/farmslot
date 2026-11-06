import assert from 'node:assert/strict';

export async function runScenario(c) {
  await c.start();
  let capped;
  for (let round = 1; round <= 5; round++) {
    capped = await c.wait(`review round ${round} returns findings`, async (run) => {
      await c.answer(run, true);
      return (
        run.reviewRoundAdmissions?.length === round &&
        run.status === 'blocked' &&
        run.decisions.some(
          (decision) => !decision.resolvedAt && decision.type === 'engine_review_complete',
        )
      );
    });
    const decision = capped.decisions.find(
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
    if (round < 5) await c.replay('review');
  }
  await c.replay('review');
  await c.wait('ungranted sixth round is refused', (run) => {
    const failure = run.steps.find((step) => step.name === 'review');
    return (
      ['blocked', 'failed'].includes(run.status) &&
      /review.*(budget|round|limit)|5\/5/i.test(failure?.detail ?? run.error ?? '')
    );
  });
  assert.equal((await c.get()).reviewRoundAdmissions.length, 5);
  const headSha = c.git('rev-parse', 'HEAD');
  await c.call('run.extendReviewBudget', {
    runId: capped.id,
    slotId: c.slotId,
    requestId: 'round-six',
    expectedLimit: 5,
    limit: 6,
    headSha,
    scopeBrief: 'One further static review of the fixture revision.',
  });
  await c.replay('review');
  const recovered = await c.wait('round six completes', async (run) => {
    await c.answer(run, false);
    return (
      run.reviewRoundAdmissions?.length === 6 &&
      run.steps.find((step) => step.name === 'review')?.status === 'done'
    );
  });
  assert.equal(recovered.reviewRoundAdmissions.length, 6);
}
