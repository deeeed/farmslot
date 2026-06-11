import assert from 'node:assert/strict';
import test from 'node:test';

import { AddError, expandHookTemplate } from './add.js';

test('expandHookTemplate substitutes slot vars', () => {
  assert.equal(
    expandHookTemplate('node scripts/build.mjs --port {{port}} --slot {{slot_id}}', {
      port: 9300,
      slot_id: 'm-app-1',
    }),
    'node scripts/build.mjs --port 9300 --slot m-app-1',
  );
});

test('expandHookTemplate fails hard on unknown variables', () => {
  assert.throws(
    () => expandHookTemplate('run --device {{adb_serial}}', { port: 1 }),
    (err: unknown) =>
      err instanceof AddError && /unknown variable \{\{adb_serial\}\}/.test(err.message),
  );
});
