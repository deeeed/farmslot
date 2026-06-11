import assert from 'node:assert/strict';
import test from 'node:test';

import { redactProfile } from './gateway.js';

test('redactProfile never exposes the secret in any output shape', () => {
  const entry = redactProfile(
    'lab',
    { url: 'wss://lab:7777', authMode: 'token', secret: 'topsecret' },
    'lab',
  );
  assert.deepEqual(entry, {
    name: 'lab',
    url: 'wss://lab:7777',
    active: true,
    authMode: 'token',
    loggedIn: true,
  });
  assert.ok(!JSON.stringify(entry).includes('topsecret'));
});
