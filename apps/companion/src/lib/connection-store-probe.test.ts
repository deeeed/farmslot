import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ConnectionProbeAttemptTracker,
  connectionProbeInvalidation,
} from './connection-store-probe';

const started = {
  client: {},
  gatewayUrl: 'ws://gateway.test/ws',
  profileId: 'gateway-a',
  connectionGeneration: 1,
};

test('Retry records transport generation churn as a liveness failure', () => {
  assert.deepEqual(
    connectionProbeInvalidation(started, { ...started, connectionGeneration: 2 }, true),
    {
      kind: 'transport',
      error: 'Gateway transport changed while testing.',
    },
  );
});

test('socket flapping cannot let an older attempt clear a newer probe', () => {
  const tracker = new ConnectionProbeAttemptTracker();
  let probeInProgress = true;
  const retryAttempt = tracker.begin();
  const socketFlapAttempt = tracker.begin();

  if (tracker.isCurrent(retryAttempt)) probeInProgress = false;
  assert.equal(probeInProgress, true);

  if (tracker.isCurrent(socketFlapAttempt)) probeInProgress = false;
  assert.equal(probeInProgress, false);
});

test('profile switches stay distinct from transport generation changes', () => {
  assert.deepEqual(
    connectionProbeInvalidation(
      started,
      {
        ...started,
        profileId: 'gateway-b',
        connectionGeneration: 2,
      },
      false,
    ),
    {
      kind: 'profile',
      error: 'Gateway profile changed while testing.',
    },
  );
});
