import assert from 'node:assert/strict';
export async function runScenario(c) {
  await c.start();
  const failed = await c.wait(
    'silent reviewer reaches inactivity limit',
    (run) => run.steps.find((step) => step.name === 'review')?.status === 'failed',
  );
  assert.match(
    failed.steps.find((step) => step.name === 'review')?.detail ?? failed.error ?? '',
    /no checklist or tool progress|inactivity/i,
  );
  await c.replay('review');
  await c.wait('review replay completes', async (run) => {
    await c.answer(run, false);
    return run.steps.find((step) => step.name === 'review')?.status === 'done';
  });
}
