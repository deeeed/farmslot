import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export async function runScenario(c) {
  await c.start();
  let sawDeferredActive = false;
  await c.wait('late acknowledgement survives its launch window', async (run) => {
    const reviews = run.agentContexts?.filter((context) => context.role === 'review') ?? [];
    await c.answer(run, reviews.length === 1);
    if (!run.agentContexts?.some((context) => context.role === 'review-fix')) return false;
    for (const entry of await readdir(path.join(c.repo, '.agent'))) {
      if (!entry.startsWith('scripted-')) continue;
      const receipt = JSON.parse(
        await readFile(path.join(c.repo, '.agent', entry, 'session.json'), 'utf8'),
      );
      if (receipt.acknowledged && receipt.observedAt - receipt.turnStartedAt >= 150)
        sawDeferredActive = true;
    }
    return (
      reviews.length >= 2 && run.steps.find((step) => step.name === 'review')?.status === 'done'
    );
  });
  assert.ok(sawDeferredActive, 'F406: the accepted fix stayed active beyond the launch window');
}
