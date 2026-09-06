import assert from 'node:assert/strict';
import test from 'node:test';

import { recipeRerunTarget } from './recipe-rerun-target.js';

test('an empty device field replays on the slot configured device', () => {
  assert.deepEqual(recipeRerunTarget('simulator', ''), {});
  assert.deepEqual(recipeRerunTarget('simulator', '   '), {});
});

test('a device identity becomes the rerun target under the chosen key', () => {
  assert.deepEqual(recipeRerunTarget('simulator', ' SIM-2 '), { target: { simulator: 'SIM-2' } });
  assert.deepEqual(recipeRerunTarget('adb_serial', 'emulator-5554'), {
    target: { adb_serial: 'emulator-5554' },
  });
});

test('a device identity the Gateway would refuse is refused in the client too', () => {
  const refused = recipeRerunTarget('simulator', '$(whoami)');
  assert.equal(refused.target, undefined);
  assert.match(refused.error ?? '', /Device identity must match/);
});

test('a key that is not a device identity parameter is refused', () => {
  const refused = recipeRerunTarget('recordVideo', 'true');
  assert.equal(refused.target, undefined);
  assert.match(refused.error ?? '', /is not a device identity parameter/);
});
