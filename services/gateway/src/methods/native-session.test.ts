import assert from 'node:assert/strict';
import test from 'node:test';

import type { Principal } from '@farmslot/protocol';

import { nativeRouteError, nativeSessionRoute } from './native-session.js';

test('native RPC fails closed without an authenticated pinned profile owner', async () => {
  const principal: Principal = {
    id: 'untrusted',
    subject: { type: 'person', displayName: 'Untrusted' },
    roles: [],
  };
  await assert.rejects(
    nativeSessionRoute('native.session.list', {}, principal),
    /authenticated owner/,
  );
  await assert.rejects(
    nativeSessionRoute('native.session.create', { runner: 'codex', cwd: '/tmp' }, principal),
    /authenticated owner/,
  );
});

test('a failed profile sample reaches clients as profiles unavailable, not a session error', () => {
  const error = nativeRouteError(
    Object.assign(new Error('Native account profiles are unavailable on this node.'), {
      code: 'NATIVE_PROFILES_UNAVAILABLE',
    }),
  );
  assert.equal(error.code, 'NATIVE_PROFILES_UNAVAILABLE');
  assert.equal(nativeRouteError(new Error('boom')).code, 'NATIVE_SESSION_ERROR');
});
