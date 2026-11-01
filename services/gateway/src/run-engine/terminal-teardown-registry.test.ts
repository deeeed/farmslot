import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';

import { assertCleanupCurrent } from '../core/cleanup-scope.js';

import {
  beginTerminalTeardown,
  endTerminalTeardown,
  extendTerminalTeardown,
  isTerminalTeardownInFlight,
  TERMINAL_TEARDOWN_TIMEOUT_MS,
  withTerminalTeardown,
} from './terminal-teardown-registry.js';

test('successful and failed teardowns release only their own registry count', async () => {
  const slot = 'f204-overlapping-cleanups';
  beginTerminalTeardown(slot);
  try {
    assert.equal(
      await withTerminalTeardown(slot, async () => {
        assert.equal(isTerminalTeardownInFlight(slot), true);
        return 'released';
      }),
      'released',
    );
    await assert.rejects(
      withTerminalTeardown(slot, async () => {
        throw new Error('owned cleanup failed');
      }),
      /owned cleanup failed/,
    );
    assert.equal(
      isTerminalTeardownInFlight(slot),
      true,
      'the independent cleanup is still protected',
    );
  } finally {
    endTerminalTeardown(slot);
  }
  assert.equal(isTerminalTeardownInFlight(slot), false);
});

test('a hung teardown fails at its deadline and a late result cannot clear its successor', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const slot = 'f204-hung-cleanup';
  let finishOld!: () => void;
  let lateCheck: Promise<void> | undefined;
  const old = withTerminalTeardown(
    slot,
    () => {
      lateCheck = new Promise<void>((resolve) => {
        finishOld = resolve;
      }).then(() => {
        assertCleanupCurrent();
      });
      return lateCheck;
    },
    100,
  );
  const refused = assert.rejects(
    old,
    /Terminal teardown for f204-hung-cleanup timed out after 100ms/,
  );
  assert.equal(isTerminalTeardownInFlight(slot), true);
  t.mock.timers.tick(100);
  await refused;
  assert.equal(
    isTerminalTeardownInFlight(slot),
    false,
    'replay is no longer blocked by the hung promise',
  );

  let finishNext!: () => void;
  const next = withTerminalTeardown(
    slot,
    () =>
      new Promise<void>((resolve) => {
        finishNext = resolve;
      }),
    100,
  );
  finishOld();
  await assert.rejects(lateCheck!, /timed out after 100ms/);
  assert.equal(
    isTerminalTeardownInFlight(slot),
    true,
    'late settlement cannot release the new cleanup',
  );
  finishNext();
  await next;
  assert.equal(isTerminalTeardownInFlight(slot), false);
});

test('a parent deadline also unwinds a nested release and its registry count', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const slot = 'f204-nested-cleanup';
  const outer = withTerminalTeardown(
    slot,
    () => withTerminalTeardown(slot, () => new Promise<void>(() => {}), 200),
    100,
  );
  const refused = assert.rejects(outer, /timed out after 100ms/);
  t.mock.timers.tick(100);
  await refused;
  await setImmediate();
  assert.equal(isTerminalTeardownInFlight(slot), false);
});

// F298: 9dd08510's release copied 851 MB of artifacts the mirror never indexed inside the
// 300 s budget. A copy of more than 1.5 GB now extends the run teardown and the nested release.
test('an artifact copy extends every enclosing teardown, which keeps its 300 s', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const slot = 'f298-big-copy';
  const copyMs = 800_000; // 1.6 GB at 2 MB/s, longer than the whole teardown budget
  let copied!: () => void;
  let tornDown!: () => void;
  const release = withTerminalTeardown(slot, () =>
    withTerminalTeardown(slot, async () => {
      extendTerminalTeardown(copyMs + 20_000);
      await new Promise<void>((resolve) => (copied = resolve));
      await new Promise<void>((resolve) => (tornDown = resolve));
      return 'released';
    }),
  );
  await setImmediate();
  t.mock.timers.tick(copyMs);
  copied();
  await setImmediate();
  t.mock.timers.tick(TERMINAL_TEARDOWN_TIMEOUT_MS - 10_000);
  tornDown();
  assert.equal(await release, 'released');
  assert.equal(isTerminalTeardownInFlight(slot), false);
});
