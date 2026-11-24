import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { measureCompleteStep, timeCompletePhase } from './phase-timing.js';

test('a measured COMPLETE records each phase, adds repeated phases, and keeps nested ones', async () => {
  const { value, timing } = await measureCompleteStep(async () => {
    await timeCompletePhase('capture', async () => {
      await timeCompletePhase('capture.retain', () => delay(20));
    });
    await timeCompletePhase('capture', () => delay(20));
    return 'done';
  });
  assert.equal(value, 'done');
  assert.deepEqual(Object.keys(timing.phasesMs).sort(), ['capture', 'capture.retain']);
  assert.ok(timing.phasesMs.capture! >= 35, `capture ${timing.phasesMs.capture}ms`);
  assert.ok(timing.phasesMs['capture.retain']! >= 15);
  assert.ok(timing.totalMs >= timing.phasesMs.capture!);
  assert.deepEqual(timing.bundleLock, { acquisitions: 0, waitMs: 0, heldMs: 0 });
});

test('a failed phase keeps its error, and a phase outside a measured step only runs', async () => {
  assert.equal(await timeCompletePhase('push', async () => 'ran'), 'ran');
  const failure = new Error('GitHub fetch failed');
  await assert.rejects(
    measureCompleteStep(() => timeCompletePhase('push', () => Promise.reject(failure))),
    failure,
  );
});
