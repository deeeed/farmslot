import assert from 'node:assert/strict';
import test from 'node:test';

import {
  hasCurrentConnectionProbeTransport,
  hasStableConnectionProbeIdentity,
  isCurrentConnectionProbe,
} from './connection-probe-identity';

test('same-URL probes become stale when credentials advance the connection generation', () => {
  const client = {};
  const started = {
    client,
    gatewayUrl: 'ws://gateway.test/ws',
    profileId: 'gateway-a',
    connectionGeneration: 4,
  };

  assert.equal(
    hasStableConnectionProbeIdentity(started, {
      client,
      gatewayUrl: started.gatewayUrl,
      profileId: started.profileId,
    }),
    true,
  );
  assert.equal(
    hasCurrentConnectionProbeTransport(started, {
      ...started,
      connectionGeneration: 5,
    }),
    false,
  );
  assert.equal(
    isCurrentConnectionProbe(started, {
      ...started,
      connectionGeneration: 5,
    }),
    false,
  );
  assert.equal(isCurrentConnectionProbe(started, { ...started }), true);
});

test('profile identity changes are distinct from transport generation churn', () => {
  const started = {
    client: {},
    gatewayUrl: 'ws://gateway.test/ws',
    profileId: 'gateway-a',
  };

  assert.equal(hasStableConnectionProbeIdentity(started, { ...started }), true);
  assert.equal(
    hasStableConnectionProbeIdentity(started, {
      ...started,
      profileId: 'gateway-b',
    }),
    false,
  );
});
