import assert from 'node:assert/strict';
import test from 'node:test';

import { createSlotUpdateScheduler } from './state.js';

test('slot updates coalesce, rate-limit and never starve under steady writes', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const fired: number[] = [];
  const trigger = createSlotUpdateScheduler(() => fired.push(Date.now()), {
    coalesceMs: 50,
    minIntervalMs: 250,
    now: () => Date.now(),
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

test('a wall-clock step back does not stall slot update broadcasts', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10 * 3_600_000 });
  let fired = 0;
  // The default clock: monotonic, so a wall-clock step cannot move the next deadline.
  const trigger = createSlotUpdateScheduler(() => fired++, { coalesceMs: 50, minIntervalMs: 250 });
  trigger();
  t.mock.timers.tick(50);
  assert.equal(fired, 1);
  t.mock.timers.setTime(Date.now() - 3_600_000);
  trigger();
  t.mock.timers.tick(300);
  assert.equal(fired, 2, 'the next write still broadcasts within one rate-limit window');
});
