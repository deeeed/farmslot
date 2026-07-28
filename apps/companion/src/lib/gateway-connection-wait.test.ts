import assert from 'node:assert/strict';
import test from 'node:test';

import { connectionWaitTerminalError } from './gateway-connection-wait';

test('connection waits preserve the retry window after transient transport failures', () => {
  assert.equal(
    connectionWaitTerminalError(false, 'Gateway connection closed before authentication completed'),
    null,
  );
});

test('connection waits fail immediately for background pauses and honest auth errors', () => {
  assert.equal(
    connectionWaitTerminalError(true, null),
    'Gateway paused while app is in the background',
  );
  assert.equal(
    connectionWaitTerminalError(false, 'Authentication failed: invalid token'),
    'Authentication failed: invalid token',
  );
});
