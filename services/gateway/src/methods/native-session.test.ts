import assert from 'node:assert/strict';
import test from 'node:test';

import { nativeSessionRoute } from './native-session.js';

test('native RPC fails closed without an authenticated pinned profile owner', async () => {
  await assert.rejects(nativeSessionRoute('native.session.list', {}), /principal.*own/);
  await assert.rejects(
    nativeSessionRoute('native.session.create', { runner: 'codex', cwd: '/tmp' }),
    /principal.*own/,
  );
});
