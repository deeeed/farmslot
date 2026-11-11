import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';

import { startGitHubFixture } from '../integrations/github-test-fixtures.js';

// Requests to the fixture wait until released, so they hold every client concurrency slot.
const held: Array<() => void> = [];
const fixture = await startGitHubFixture(
  () =>
    new Promise((resolve) => {
      held.push(() => resolve({ body: { ok: true } }));
    }),
);
process.env.FARMSLOT_GITHUB_API_URL = fixture.origin;

const config = await import('../core/config.js');
mock.module('../core/config.js', {
  namedExports: {
    ...config,
    loadProjectVars: async () => ({ projectJson: { ci: { repo: 'org/app' } } }),
  },
});
const { github } = await import('../integrations/github-client.js');
const { readUpstreamPr } = await import('./stack-retarget.js');

after(async () => {
  for (const release of held.splice(0)) release();
  delete process.env.FARMSLOT_GITHUB_API_URL;
  await fixture.close();
});

test('a stacked PR read keeps its whole-call deadline while every client slot is busy', async (t) => {
  const occupying = Array.from({ length: 8 }, (_, i) =>
    github.rest('GET', `occupy/${i}`, { force: true }),
  );
  for (let i = 0; i < 400 && fixture.requests.length < 8; i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(fixture.requests.length, 8, 'all eight slots are held');

  // A real timer bounds the test if the deadline is ever lost.
  const [realSetTimeout, realClearTimeout] = [setTimeout, clearTimeout];
  let guard: NodeJS.Timeout | undefined;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const read = readUpstreamPr('app', 7);
  const outcome = assert.rejects(read, /reading PR #7 timed out after 90s/);
  // Let the read reach the slot queue, then run past the deadline.
  for (let i = 0; i < 10; i++) await Promise.resolve();
  t.mock.timers.tick(90_000);
  try {
    await Promise.race([
      outcome,
      new Promise((_, reject) => {
        guard = realSetTimeout(() => reject(new Error('no deadline fired')), 5000);
      }),
    ]);
  } finally {
    realClearTimeout(guard);
  }
  t.mock.timers.reset();
  assert.equal(fixture.requests.length, 8, 'the read never got a slot');

  for (const release of held.splice(0)) release();
  await Promise.all(occupying);
});
