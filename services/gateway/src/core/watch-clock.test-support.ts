import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { setImmediate } from 'node:timers/promises';

/** Drain Chokidar's startup throttles on a test clock before native producer writes. */
export async function withWatcherClock<T>(t: TestContext, start: () => Promise<T>): Promise<T> {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const value = await start();
    // Chokidar uses 0, 5, 50, 100 and 1000 ms throttles while discovering trees.
    t.mock.timers.tick(1001);
    return value;
  } finally {
    t.mock.timers.reset();
  }
}

/** Advance production timers while native filesystem events run on the event loop. */
export function watcherClock(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  return {
    flush: () => t.mock.timers.tick(1001),
    async until(check: () => boolean, label: string): Promise<void> {
      const deadline = performance.now() + 1500;
      while (!check() && performance.now() < deadline) {
        t.mock.timers.tick(1);
        await setImmediate();
      }
      assert(check(), label);
    },
  };
}
