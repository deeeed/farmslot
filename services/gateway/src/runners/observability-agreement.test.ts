import assert from 'node:assert/strict';
import test from 'node:test';

import { disagreementReason } from './observability-agreement.js';

test('disagreementReason classifies hook-composing vs pane-idle mismatch', () => {
  assert.equal(
    disagreementReason({ paneBusy: false, hookBusy: true, hookActivity: 'composing' }),
    'hook-composing-pane-idle',
  );
});

test('disagreementReason returns undefined when pane and hook agree', () => {
  assert.equal(
    disagreementReason({ paneBusy: true, hookBusy: true, hookActivity: 'tool-running' }),
    undefined,
  );
});

test('disagreementReason marks unavailable hook signal', () => {
  assert.equal(
    disagreementReason({ paneBusy: false, hookBusy: null, hookActivity: null }),
    'hook-unavailable',
  );
});