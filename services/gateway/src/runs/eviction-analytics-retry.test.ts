process.env.NODE_TEST_CONTEXT = '1';

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mock, test, type TestContext } from 'node:test';

import { type Run, trimRunForList } from '@farmslot/protocol';
import { canonicalResourceJson } from '@farmslot/protocol/client-cache';

await import('../runtime/mock-pty.test-support.js');
const analytics = await import('./analytics.js');
const { captureRunResources, publishRunResources } = await import('../resources/run-changes.js');

// One eviction append at a time is controlled by the test: it lets an earlier append land (flag
// set and published), waits while a reader caches the row's version, then fails.
let evictionAppend: ((run: Run) => Promise<void>) | undefined;
mock.module('./analytics.js', {
  namedExports: {
    ...analytics,
    emitAnalyticsForTerminalRun: (run: Run) => (evictionAppend ? evictionAppend(run) : null),
  },
});
// analytics.js already loaded the store with the real emitter; take a store bound to the mock.
const storeModule: string = './store.js?eviction-analytics-retry';
const { archiveRun, createRun, deleteRun, getRun, updateRun }: typeof import('./store.js') =
  await import(storeModule);
const { runListVersions } = await import('./list-version.js');

const servedVersion = (run: Run) =>
  createHash('sha256')
    .update(canonicalResourceJson(trimRunForList(run)))
    .digest('hex');
const listedVersion = (id: string) => runListVersions([getRun(id)!])[0]!.version;

function terminalRun(t: TestContext, ticketOrPr: string): Run {
  const run = createRun({ flowType: 'dev', project: 'eviction-retry', ticketOrPr });
  updateRun(run.id, { status: 'done', completedAt: new Date().toISOString() });
  t.after(async () => {
    evictionAppend = undefined;
    if (getRun(run.id)) await deleteRun(run.id);
  });
  return getRun(run.id)!;
}

for (const evict of [
  { name: 'archive', run: (id: string) => archiveRun(id) },
  { name: 'delete', run: (id: string) => deleteRun(id) },
]) {
  test(`a failed ${evict.name} append that clears a published analytics flag republishes the run`, async (t) => {
    const run = terminalRun(t, `EVICTION-RETRY-${evict.name.toUpperCase()}`);
    let cached: string | undefined;
    evictionAppend = async (live) => {
      // The completion append lands while the eviction append waits behind it.
      live.analyticsEmittedAt = live.completedAt;
      publishRunResources(captureRunResources(live));
      cached = listedVersion(live.id);
      throw new Error('analytics sink unavailable');
    };
    assert.equal(await evict.run(run.id), false, 'a failed append keeps the run');
    const kept = getRun(run.id)!;
    assert.equal(kept.analyticsEmittedAt, undefined, 'the flag is cleared for a later retry');
    assert.equal(cached, servedVersion({ ...kept, analyticsEmittedAt: kept.completedAt }));
    assert.equal(listedVersion(run.id), servedVersion(kept));
  });
}
