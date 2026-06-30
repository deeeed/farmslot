import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { terminalAttachOverlay, terminalShowsLiveBadge } from './terminal-view-attach-model.js';

test('terminalAttachOverlay shows connecting and sizing phases', () => {
  assert.deepEqual(
    terminalAttachOverlay({
      hasTarget: true,
      attachPhase: 'connecting',
      reconnecting: false,
      recoveryMessage: '',
      mode: 'none',
    }),
    { show: true, message: 'Connecting to terminal…' },
  );
  assert.deepEqual(
    terminalAttachOverlay({
      hasTarget: true,
      attachPhase: 'sizing',
      reconnecting: false,
      recoveryMessage: '',
      mode: 'pty',
    }),
    { show: true, message: 'Syncing terminal size…' },
  );
  assert.deepEqual(
    terminalAttachOverlay({
      hasTarget: true,
      attachPhase: 'live',
      reconnecting: false,
      recoveryMessage: '',
      mode: 'pty',
    }),
    { show: false, message: '' },
  );
});

test('terminalAttachOverlay prefers recovery message while reconnecting', () => {
  assert.deepEqual(
    terminalAttachOverlay({
      hasTarget: true,
      attachPhase: 'live',
      reconnecting: true,
      recoveryMessage: 'Recovering terminal…',
      mode: 'pty',
    }),
    { show: true, message: 'Recovering terminal…' },
  );
});

test('terminalShowsLiveBadge waits until live phase', () => {
  assert.equal(terminalShowsLiveBadge('pty', 'sizing'), false);
  assert.equal(terminalShowsLiveBadge('pty', 'live'), true);
  assert.equal(terminalShowsLiveBadge('poll', 'live'), false);
});
