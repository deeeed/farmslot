import assert from 'node:assert/strict';
import test from 'node:test';

import { isWorkerMonitorPhase } from './worker-monitor-phase.js';

test('worker monitor phase matches production orchestration idle shape', () => {
  // Repro: during grade/prepare the fleet row is busy/preparing + agent idle.
  assert.equal(
    isWorkerMonitorPhase({ lifecycle: 'busy', phase: 'preparing' }),
    false,
    'orchestration must not be treated as worker monitor',
  );
  assert.equal(
    isWorkerMonitorPhase({ lifecycle: 'busy', phase: 'working' }),
    true,
    'live monitor worker phase should remain eligible',
  );
});
