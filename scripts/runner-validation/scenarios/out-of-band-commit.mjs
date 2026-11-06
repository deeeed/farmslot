import assert from 'node:assert/strict';
export async function runScenario(c) {
  await c.start();
  await c.wait('reviewed run reaches its gate', async (run) => {
    await c.answer(run, false);
    return run.decisions.some(
      (decision) => !decision.resolvedAt && decision.type === 'engine_human_gate',
    );
  });
  const before = c.git('rev-parse', 'HEAD');
  await c.scripted('commit-out-of-band');
  const head = c.git('rev-parse', 'HEAD');
  assert.notEqual(head, before);
  await c.replay('review');
  const run = await c.wait('review replay captures external head', async (run) => {
    await c.answer(run, false);
    return run.steps.find((step) => step.name === 'review')?.status === 'done';
  });
  assert.ok(
    JSON.stringify(run.steps.find((step) => step.name === 'review')?.outputs).includes(head),
    'review replay must review the external head',
  );
}
