import assert from 'node:assert/strict';
import test from 'node:test';

import { createSlotUpdateScheduler } from './state.js';

test('slot updates coalesce, rate-limit and never starve under steady writes', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const fired: number[] = [];
  const trigger = createSlotUpdateScheduler(() => fired.push(Date.now()), {
    coalesceMs: 50,
    minIntervalMs: 250,
  });

  // A burst of writes becomes one broadcast after the coalescing wait.
  trigger();
  t.mock.timers.tick(10);
  trigger();
  t.mock.timers.tick(40);
  assert.deepEqual(fired, [50]);

  // A write every 10 ms for two seconds: a debounce would never fire until the writes stop.
  for (let elapsed = 0; elapsed < 2000; elapsed += 10) {
    trigger();
    t.mock.timers.tick(10);
  }
  const steady = fired.slice(1);
  assert.ok(steady.length >= 7, `expected steady broadcasts, got ${steady.length}`);
  for (const [index, at] of fired.entries())
    if (index)
      assert.ok(at - fired[index - 1] >= 250, `broadcasts ${index - 1}-${index} too close`);
  t.mock.timers.tick(300);

  // After a quiet period the next write broadcasts after only the coalescing wait.
  t.mock.timers.tick(1000);
  const before = Date.now();
  trigger();
  t.mock.timers.tick(50);
  assert.equal(fired.at(-1), before + 50);
});
