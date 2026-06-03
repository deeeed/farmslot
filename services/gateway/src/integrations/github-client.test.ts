import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isGhPRChecksPendingExit } from './github-client.js';

test('isGhPRChecksPendingExit preserves pending pr checks stdout', () => {
  assert.equal(
    isGhPRChecksPendingExit(
      ['pr', 'checks', '123', '--repo', 'owner/repo', '--json', 'name,bucket'],
      { code: 8, stdout: '[{"name":"lint","bucket":"pending"}]\n' },
    ),
    true,
  );
});

test('isGhPRChecksPendingExit rejects non-data or non-check failures', () => {
  assert.equal(isGhPRChecksPendingExit(['pr', 'checks', '123'], { code: 8, stdout: '' }), false);
  assert.equal(isGhPRChecksPendingExit(['pr', 'view', '123'], { code: 8, stdout: '{}' }), false);
  assert.equal(isGhPRChecksPendingExit(['pr', 'checks', '123'], { code: 1, stdout: '{}' }), false);
});
