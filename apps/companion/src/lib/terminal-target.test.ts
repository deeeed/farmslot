import assert from 'node:assert/strict';
import test from 'node:test';

import { shouldUseBareTerminalSessionForRun } from './terminal-target';

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
