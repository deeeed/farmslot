import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeAttentionPrefs } from './attention-prefs';

test('attention preferences default on and retain explicit opt-outs', () => {
  assert.deepEqual(normalizeAttentionPrefs(undefined), {
    enabled: true,
    sound: true,
    haptics: true,
  });
  assert.deepEqual(normalizeAttentionPrefs(null), {
    enabled: true,
    sound: true,
    haptics: true,
  });
  assert.deepEqual(normalizeAttentionPrefs({ enabled: false, haptics: false }), {
    enabled: false,
    sound: true,
    haptics: false,
  });
});
