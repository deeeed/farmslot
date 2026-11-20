import assert from 'node:assert/strict';
import test from 'node:test';

import { launchLiteLlmRoute } from './review-launch-route.js';

const A = 'sha256:' + 'a'.repeat(64);
const B = 'sha256:' + 'b'.repeat(64);
const none = { launchLiteLlmEndpointId: undefined, launchLiteLlmRouteUnverified: undefined };

test('a fresh transcript takes its launch route, and a launch with none recorded stays legacy', () => {
  assert.deepEqual(launchLiteLlmRoute({ liteLlmEndpointId: A }, undefined, false), {
    ...none,
    launchLiteLlmEndpointId: A,
  });
  // A fresh transcript does not inherit an earlier transcript's state.
  assert.deepEqual(
    launchLiteLlmRoute(
      { liteLlmEndpointId: A },
      { launchLiteLlmRouteUnverified: 'mixed-routes' },
      false,
    ),
    { ...none, launchLiteLlmEndpointId: A },
  );
  assert.deepEqual(launchLiteLlmRoute({ liteLlmRouteUnverified: true }, undefined, false), {
    ...none,
    launchLiteLlmRouteUnverified: 'unknown-route',
  });
  // Another runner, or a task runtime from before route receipts: unchanged pricing.
  assert.deepEqual(launchLiteLlmRoute({}, { launchLiteLlmEndpointId: A }, false), none);
});

test('a continued transcript keeps its earlier turns bound only to the same verified route', () => {
  const prior = { launchLiteLlmEndpointId: A };
  assert.deepEqual(launchLiteLlmRoute({ liteLlmEndpointId: A }, prior, true), {
    ...none,
    launchLiteLlmEndpointId: A,
  });
  // A resume on another route never reprices the earlier turns at its rates.
  assert.deepEqual(launchLiteLlmRoute({ liteLlmEndpointId: B }, prior, true), {
    ...none,
    launchLiteLlmRouteUnverified: 'mixed-routes',
  });
  for (const receipt of [{ liteLlmRouteUnverified: true as const }, {}])
    assert.deepEqual(launchLiteLlmRoute(receipt, prior, true), {
      ...none,
      launchLiteLlmRouteUnverified: 'unknown-route',
    });
  // Once unverified, a later matching launch cannot restore pricing for the transcript.
  assert.deepEqual(
    launchLiteLlmRoute(
      { liteLlmEndpointId: A },
      { launchLiteLlmRouteUnverified: 'mixed-routes' },
      true,
    ),
    { ...none, launchLiteLlmRouteUnverified: 'mixed-routes' },
  );
  // Earlier turns with no recorded route (an old receipt) are unverified once a route is recorded.
  assert.deepEqual(launchLiteLlmRoute({ liteLlmEndpointId: A }, {}, true), {
    ...none,
    launchLiteLlmRouteUnverified: 'unknown-route',
  });
  // Neither side recorded a route: old receipts and other runners keep their pricing.
  assert.deepEqual(launchLiteLlmRoute({}, undefined, true), none);
});
