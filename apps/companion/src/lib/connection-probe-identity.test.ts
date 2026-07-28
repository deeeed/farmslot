import assert from 'node:assert/strict';
import test from 'node:test';

import { isCurrentConnectionProbe } from './connection-probe-identity';

test('same-URL probes become stale when credentials advance the connection generation', () => {
  const client = {};
  const started = {
    client,
    gatewayUrl: 'ws://gateway.test/ws',
    connectionGeneration: 4,
  };

  assert.equal(
    isCurrentConnectionProbe(started, {
      ...started,
      connectionGeneration: 5,
    }),
    false,
  );
  assert.equal(isCurrentConnectionProbe(started, { ...started }), true);
});
