import assert from 'node:assert/strict';
import test from 'node:test';

import type { Principal } from '@farmslot/protocol';

import { nativeSessionRoute } from './native-session.js';

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
