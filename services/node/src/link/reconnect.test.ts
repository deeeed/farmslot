import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AUTH_RETRY_DELAY, MAX_TRANSPORT_BACKOFF, nodeLinkReconnectDelay } from './reconnect.js';

test('node-link jitter remains bounded and never shortens authentication cooldown', () => {
  assert.equal(
    nodeLinkReconnectDelay(500, () => 0),
    400,
  );
  assert.equal(
    nodeLinkReconnectDelay(500, () => 0.5),
    500,
  );
  assert.equal(
    nodeLinkReconnectDelay(500, () => 1),
    600,
  );
  assert.equal(
    nodeLinkReconnectDelay(MAX_TRANSPORT_BACKOFF, () => 1),
    MAX_TRANSPORT_BACKOFF,
  );
  assert.equal(
    nodeLinkReconnectDelay(AUTH_RETRY_DELAY, () => 0),
    AUTH_RETRY_DELAY,
  );
  assert.equal(
    nodeLinkReconnectDelay(AUTH_RETRY_DELAY, () => 1),
    36_000,
  );
});
