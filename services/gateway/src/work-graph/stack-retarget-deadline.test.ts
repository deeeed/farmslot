import assert from 'node:assert/strict';
import { after, mock, test, type TestContext } from 'node:test';

import { startGitHubFixture } from '../integrations/github-test-fixtures.js';

// Requests to the fixture wait until released, so they hold every client concurrency slot;
// while draining, they are answered at once.
const held: Array<() => void> = [];
let draining = false;
const fixture = await startGitHubFixture((): Promise<{ body: { ok: boolean } }> => {
  if (draining) return Promise.resolve({ body: { ok: true } });
  return new Promise((resolve) => {
    held.push(() => resolve({ body: { ok: true } }));
  });
});
process.env.FARMSLOT_GITHUB_API_URL = fixture.origin;

const config = await import('../core/config.js');
mock.module('../core/config.js', {
  namedExports: {
    ...config,
    loadProjectVars: async () => ({ projectJson: { ci: { repo: 'org/app' } } }),
  },
});
const { github } = await import('../integrations/github-client.js');
const { readUpstreamPr, retargetStackedPr } = await import('./stack-retarget.js');
const { makeRun } = await import('../run-engine/test-fixtures.js');

after(async () => {
  for (const release of held.splice(0)) release();
  delete process.env.FARMSLOT_GITHUB_API_URL;
  await fixture.close();
});

/** Holds all eight client slots, starts `call`, and runs the clock past its 90-second deadline. */
async function assertDeadlineWhileSaturated(
  t: TestContext,
  call: () => Promise<unknown>,
  timedOut: RegExp,
): Promise<void> {
  const before = fixture.requests.length;
  const occupying = Array.from({ length: 8 }, (_, i) =>
    github.rest('GET', `occupy/${before}-${i}`, { force: true }),
  );
  for (let i = 0; i < 400 && fixture.requests.length < before + 8; i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(fixture.requests.length, before + 8, 'all eight slots are held');

  // A real timer bounds the test if the deadline is ever lost.
  const [realSetTimeout, realClearTimeout] = [setTimeout, clearTimeout];
  let guard: NodeJS.Timeout | undefined;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let settled = false;
  const outcome = assert.rejects(call(), timedOut).finally(() => (settled = true));
  // The call reaches its deadline timer after a few async steps (project config, slot queue):
  // run the clock past 90 seconds until the deadline has fired.
  for (let i = 0; i < 50 && !settled; i++) {
    await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(90_000);
  }
  try {
    await Promise.race([
      outcome,
      new Promise((_, reject) => {
        guard = realSetTimeout(() => reject(new Error('no deadline fired')), 5000);
      }),
    ]);
  } finally {
    realClearTimeout(guard);
    t.mock.timers.reset();
  }
  assert.equal(fixture.requests.length, before + 8, 'the call never got a slot');

  // The timed-out request still waits for a slot: let it through and answer it, so nothing
  // carries a held slot into the next test.
  draining = true;
  try {
    for (const release of held.splice(0)) release();
    await Promise.all(occupying);
    for (let i = 0; i < 400 && fixture.requests.length < before + 9; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
  } finally {
    draining = false;
  }
}

test('a stacked PR read keeps its whole-call deadline while every client slot is busy', (t) =>
  assertDeadlineWhileSaturated(
    t,
    () => readUpstreamPr('app', 7),
    /reading PR #7 timed out after 90s/,
  ));

test('a stacked PR retarget keeps its whole-call deadline while every client slot is busy', (t) =>
  assertDeadlineWhileSaturated(
    t,
    () => retargetStackedPr(makeRun({ project: 'app', prNumber: 7 })),
    /retargeting PR #7 timed out after 90s/,
  ));
