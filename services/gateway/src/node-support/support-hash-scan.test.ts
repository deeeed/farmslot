import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

// Counts the legacy path lookups one support-hash scan makes.
let legacyLookups = 0;
const farmPaths = await import('@farmslot/protocol/node/farm-paths');
mock.module('@farmslot/protocol/node/farm-paths', {
  namedExports: {
    ...farmPaths,
    legacyRemoteFarmPaths: (...args: Parameters<typeof farmPaths.legacyRemoteFarmPaths>) => {
      legacyLookups++;
      return farmPaths.legacyRemoteFarmPaths(...args);
    },
  },
});
const { makeRun } = await import('../run-engine/test-fixtures.js');
const { resourceRevisions } = await import('../resources/revisions.js');
const { RUN_SUPPORT_SCAN_MAX_AGE_MS, RUN_SUPPORT_SCAN_PATTERNS, referencedNodeSupportHashes } =
  await import('./activation.js');

const hash = (index: number) => index.toString(16).padStart(64, '0');

/** A run whose scans are counted: a scan reads every value, its summary included. */
function countedRun(id: string, outputs: Record<string, string>) {
  const run = makeRun({
    id,
    updatedAt: '2026-11-13T00:00:00.000Z',
    steps: [{ name: 'prepare', status: 'done', outputs }],
  });
  let scans = 0;
  Object.defineProperty(run, 'summary', {
    enumerable: true,
    get: () => {
      scans++;
      return 'counted';
    },
  });
  return { run, scans: () => scans };
}

test('an unchanged run is not scanned again; one with a new updatedAt is', () => {
  const a = countedRun('cache-updated-a', { dir: `/farm/support/${hash(1)}` });
  const b = countedRun('cache-updated-b', { dir: `/farm/support/${hash(2)}` });
  const runs = [a.run, b.run];
  assert.deepEqual(referencedNodeSupportHashes(runs, '/farm/support'), [hash(1), hash(2)]);
  assert.deepEqual(referencedNodeSupportHashes(runs, '/farm/support'), [hash(1), hash(2)]);
  assert.deepEqual([a.scans(), b.scans()], [1, 1]);
  // updateRunStep changes a step in place and stamps updatedAt.
  a.run.steps[0].outputs = { dir: `/farm/support/${hash(3)}` };
  a.run.updatedAt = '2026-11-13T00:00:01.000Z';
  assert.deepEqual(referencedNodeSupportHashes(runs, '/farm/support'), [hash(3), hash(2)]);
  assert.deepEqual([a.scans(), b.scans()], [2, 1]);
});

test('a run whose resource revision advanced is scanned again, even with the same updatedAt', () => {
  const a = countedRun('cache-revision-a', { dir: `/farm/support/${hash(4)}` });
  assert.deepEqual(referencedNodeSupportHashes([a.run], '/farm/support'), [hash(4)]);
  // A published in-place write (for example the QA follow-up) that keeps updatedAt.
  a.run.steps[0].outputs = { dir: `/farm/support/${hash(5)}` };
  resourceRevisions.advance({ family: 'run', runId: a.run.id });
  assert.deepEqual(referencedNodeSupportHashes([a.run], '/farm/support'), [hash(5)]);
  assert.equal(a.scans(), 2);
});

test('a replaced record is scanned again, even with the same id and stamp', () => {
  const a = countedRun('cache-replaced', { dir: `/farm/support/${hash(6)}` });
  assert.deepEqual(referencedNodeSupportHashes([a.run], '/farm/support'), [hash(6)]);
  // A load or disk read gives a new object; its stamp can match the last one.
  const reloaded = makeRun({
    id: a.run.id,
    updatedAt: a.run.updatedAt,
    steps: [{ name: 'prepare', status: 'done', outputs: { dir: `/farm/support/${hash(7)}` } }],
  });
  assert.deepEqual(referencedNodeSupportHashes([reloaded], '/farm/support'), [hash(7)]);
});

test('a run that leaves the list is evicted and scanned again when it comes back', () => {
  const a = countedRun('cache-evicted-a', { dir: `/farm/support/${hash(8)}` });
  const b = countedRun('cache-evicted-b', { dir: `/farm/support/${hash(9)}` });
  referencedNodeSupportHashes([a.run, b.run], '/farm/support');
  assert.deepEqual(referencedNodeSupportHashes([a.run], '/farm/support'), [hash(8)]);
  assert.deepEqual(referencedNodeSupportHashes([a.run, b.run], '/farm/support'), [
    hash(8),
    hash(9),
  ]);
  assert.deepEqual([a.scans(), b.scans()], [1, 2]);
});

test('each support root keeps its own scans and gives its own hashes', () => {
  const a = countedRun('cache-roots', {
    farm: `/farm/support/${hash(10)}`,
    other: `/other/support/${hash(11)}`,
  });
  assert.deepEqual(referencedNodeSupportHashes([a.run], '/farm/support'), [hash(10)]);
  assert.deepEqual(referencedNodeSupportHashes([a.run], '/other/support'), [hash(11)]);
  assert.deepEqual(referencedNodeSupportHashes([a.run], '/farm/support'), [hash(10)]);
  assert.equal(a.scans(), 2);
});

/** The monotonic clock the scan ages by, moved by the test. */
function monotonicClock(t: test.TestContext) {
  let now = 1_000_000;
  t.mock.method(performance, 'now', () => now);
  return { tick: (ms: number) => (now += ms) };
}

test('a scan older than the maximum age is read again, though the run did not change', (t) => {
  const clock = monotonicClock(t);
  const a = countedRun('cache-expiry', { dir: `/farm/support/${hash(12)}` });
  referencedNodeSupportHashes([a.run], '/farm/support');
  clock.tick(RUN_SUPPORT_SCAN_MAX_AGE_MS - 1);
  assert.deepEqual(referencedNodeSupportHashes([a.run], '/farm/support'), [hash(12)]);
  assert.equal(a.scans(), 1);
  // A writer that skips the stamp: its change goes unseen for one window at most.
  a.run.steps[0].outputs = { dir: `/farm/support/${hash(13)}` };
  clock.tick(1);
  assert.deepEqual(referencedNodeSupportHashes([a.run], '/farm/support'), [hash(13)]);
  assert.equal(a.scans(), 2);
});

test('a wall-clock step back does not stretch the maximum age', (t) => {
  const clock = monotonicClock(t);
  const wall = Date.parse('2026-11-13T12:00:00.000Z');
  t.mock.timers.enable({ apis: ['Date'], now: wall });
  const a = countedRun('cache-rollback', { dir: `/farm/support/${hash(15)}` });
  referencedNodeSupportHashes([a.run], '/farm/support');
  // The system clock moves back an hour; the maximum age still passes in real time.
  t.mock.timers.setTime(wall - 60 * 60_000);
  clock.tick(RUN_SUPPORT_SCAN_MAX_AGE_MS);
  t.mock.timers.tick(RUN_SUPPORT_SCAN_MAX_AGE_MS);
  a.run.steps[0].outputs = { dir: `/farm/support/${hash(16)}` };
  assert.deepEqual(referencedNodeSupportHashes([a.run], '/farm/support'), [hash(16)]);
  assert.equal(a.scans(), 2);
});

test('only the most recently used support roots keep their scans', () => {
  const a = countedRun('cache-turnover', { dir: `/farm/support/${hash(14)}` });
  for (let index = 0; index <= RUN_SUPPORT_SCAN_PATTERNS; index++)
    referencedNodeSupportHashes([a.run], `/turnover/${index}`);
  assert.equal(a.scans(), RUN_SUPPORT_SCAN_PATTERNS + 1);
  // The latest root reuses its scan; the first root's scans were dropped for the ones after it.
  referencedNodeSupportHashes([a.run], `/turnover/${RUN_SUPPORT_SCAN_PATTERNS}`);
  assert.equal(a.scans(), RUN_SUPPORT_SCAN_PATTERNS + 1);
  referencedNodeSupportHashes([a.run], '/turnover/0');
  assert.equal(a.scans(), RUN_SUPPORT_SCAN_PATTERNS + 2);
});

test('one support-hash scan looks up the legacy support root once, however many strings it reads', () => {
  const runs = Array.from({ length: 200 }, (_, index) =>
    makeRun({
      id: `run-${index}`,
      steps: [
        {
          name: 'prepare',
          status: 'done',
          outputs: {
            legacy: `cd ~/farmslot-node/support/${hash(index)}/bin`,
            current: `/farm/support/${hash(index + 1000)}`,
            note: 'no support path here',
          },
        },
      ],
    }),
  );
  legacyLookups = 0;
  const hashes = referencedNodeSupportHashes(runs, '/farm/support');
  assert.equal(legacyLookups, 1);
  assert.equal(hashes.length, 400, 'both roots still match in every run');
  assert.ok(hashes.includes(hash(0)) && hashes.includes(hash(1199)));
});
