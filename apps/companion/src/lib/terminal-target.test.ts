import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCompanionTerminalTarget,
  matchesCompanionTerminalTarget,
  shouldUseBareTerminalSessionForRun,
} from './terminal-target';

test('shouldUseBareTerminalSessionForRun keeps active run targets scoped by run id', () => {
  assert.equal(
    shouldUseBareTerminalSessionForRun({
      requestedRunId: 'run-1',
      requestedSlotId: 'runner-mobile-1',
      run: { slotId: 'runner-mobile-1', status: 'monitoring' },
    }),
    false,
  );
});

test('shouldUseBareTerminalSessionForRun uses bare session for completed or detached run pages', () => {
  assert.equal(
    shouldUseBareTerminalSessionForRun({
      requestedRunId: 'run-1',
      requestedSlotId: 'runner-mobile-1',
      run: { slotId: 'runner-mobile-1', status: 'done' },
    }),
    true,
  );
  assert.equal(
    shouldUseBareTerminalSessionForRun({
      requestedRunId: 'run-1',
      requestedSlotId: 'runner-mobile-1',
      run: { slotId: null, status: 'monitoring' },
    }),
    true,
  );
  assert.equal(
    shouldUseBareTerminalSessionForRun({
      requestedRunId: 'run-1',
      requestedSlotId: 'runner-mobile-1',
      run: null,
    }),
    true,
  );
});

test('buildCompanionTerminalTarget drops run id when routing to bare session', () => {
  assert.deepEqual(
    buildCompanionTerminalTarget({
      slotId: 'runner-mobile-1',
      runId: 'run-1',
      bareSession: true,
    }),
    { slotId: 'runner-mobile-1', bareSession: true },
  );
  assert.deepEqual(
    buildCompanionTerminalTarget({
      slotId: 'runner-mobile-1',
      runId: 'run-1',
      bareSession: false,
    }),
    { slotId: 'runner-mobile-1', runId: 'run-1' },
  );
});

test('matchesCompanionTerminalTarget accepts slot-only events for bare session targets', () => {
  const target = buildCompanionTerminalTarget({
    slotId: 'runner-mobile-1',
    runId: 'run-1',
    bareSession: true,
  });

  assert.equal(matchesCompanionTerminalTarget({ slotId: 'runner-mobile-1' }, target), true);
  assert.equal(
    matchesCompanionTerminalTarget({ slotId: 'runner-mobile-1', runId: 'other' }, target),
    true,
  );
  assert.equal(matchesCompanionTerminalTarget({ slotId: 'runner-mobile-2' }, target), false);
});
