import assert from 'node:assert/strict';
import test from 'node:test';
import { URL } from 'node:url';

import { Methods } from '@farmslot/protocol';

import { isGatewayBackgroundPauseError } from '../lib/recoverable-errors';
import { postureAfterPausedRefresh, postureWhileRefreshing } from '../lib/run-resource-posture';

import { mountHook } from './hook-harness.fixtures';

type Client = { request: () => Promise<never> };

function mount() {
  return mountHook<[Client | null, string | null, string]>(
    new URL('./useRunResourcePosture.ts', import.meta.url),
    'useRunResourcePosture',
    {
      '@farmslot/protocol': { Methods },
      '../lib/recoverable-errors': { isGatewayBackgroundPauseError },
      '../lib/run-resource-posture': { postureAfterPausedRefresh, postureWhileRefreshing },
    },
  );
}

const inFlight: Client = { request: () => new Promise<never>(() => undefined) };

/** The posture status one render returned. The hook runs in its own realm, so compare fields. */
function status(rendered: unknown): unknown {
  if (typeof rendered !== 'object' || rendered === null || !('posture' in rendered)) return null;
  const { posture } = rendered;
  return typeof posture === 'object' && posture !== null && 'status' in posture
    ? posture.status
    : null;
}

test('a run with a client is loading from the first render, so its panel mounts reserved', () => {
  assert.equal(status(mount().render(inFlight, 'run-1', '')), 'loading');
});

test('without a client or a run nothing is read and nothing is reserved', () => {
  assert.equal(status(mount().render(null, 'run-1', '')), 'idle');
  assert.equal(status(mount().render(inFlight, null, '')), 'idle');
});
