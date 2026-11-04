import assert from 'node:assert/strict';
import test from 'node:test';
import { PerformanceRecorder } from '../../../packages/protocol/src/performance/index.js';
import { judgePerformanceWorkload } from './performance-budget.mjs';
function fixture(cached = 0.05, omitStored = false) {
  const recorder = new PerformanceRecorder('gateway');
  for (let i = 0; i < 20; i++) {
    for (const method of ['family.observability.get', 'fleet.status', 'decision.resolve'])
      recorder.observe('farmslot_rpc_duration_seconds', { method }, 0.01);
    for (const side of ['command-center', 'companion'] as const) {
      for (const source of ['memory', 'stored'] as const) {
        if (omitStored && source === 'stored') continue;
        recorder.observe(
          'farmslot_client_cached_paint_seconds',
          { method: 'run.get', side, action_class: 'cached-paint', cache_source: source },
          cached,
        );
      }
      recorder.observe(
        'farmslot_client_background_refresh_seconds',
        { method: 'run.get', side, action_class: 'background-refresh' },
        0.1,
      );
    }
  }
  return recorder.snapshot();
}
test('normal nightly passes complete coverage and flags a repeatable paint regression', () => {
  assert.deepEqual(judgePerformanceWorkload(fixture()).differences, []);
  assert(
    judgePerformanceWorkload(fixture(0.101)).differences.some((v) =>
      v.includes('fail command-center/cached-paint'),
    ),
  );
});
test('missing stored paint and missing entire classes cannot pass', () => {
  assert(
    judgePerformanceWorkload(fixture(0.05, true)).differences.some((v) =>
      v.includes('unmeasured command-center/cached-paint/stored'),
    ),
  );
  assert(
    judgePerformanceWorkload(new PerformanceRecorder('gateway').snapshot()).differences.length >= 7,
  );
});
