import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeAttentionAlertPreferences } from './notifications.js';

test('attention preferences default on and preserve explicit opt-outs', () => {
  assert.deepEqual(normalizeAttentionAlertPreferences(null), {
    attentionEnabled: true,
    sound: true,
    backgroundNotifications: true,
  });
  assert.deepEqual(normalizeAttentionAlertPreferences({ attentionEnabled: false, sound: false }), {
    attentionEnabled: false,
    sound: false,
    backgroundNotifications: true,
  });
});
