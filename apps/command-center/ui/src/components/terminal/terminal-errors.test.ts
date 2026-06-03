import assert from 'node:assert/strict';
import test from 'node:test';

import { isRetryableTerminalSubscribeError, isRoleWindowMissingError } from './terminal-errors.js';

test('isRetryableTerminalSubscribeError treats worker-window startup as retryable', () => {
  assert.equal(
    isRetryableTerminalSubscribeError(
      new Error(
        'Tmux target mm-1:self-review for role self-review is not available yet; wait for that worker window to start and reopen the terminal.',
      ),
    ),
    true,
  );
});

test('isRetryableTerminalSubscribeError treats subscribe timeout as retryable', () => {
  assert.equal(
    isRetryableTerminalSubscribeError(
      new Error('Request terminal.subscribe timed out after 15000ms'),
    ),
    true,
  );
});

test('isRetryableTerminalSubscribeError leaves hard subscribe failures non-retryable', () => {
  assert.equal(isRetryableTerminalSubscribeError(new Error('permission denied')), false);
});

test('isRoleWindowMissingError matches role-not-available and missing-context messages', () => {
  assert.equal(
    isRoleWindowMissingError(
      'Tmux target mm-2:fix-bug for role fix-bug is not available yet; wait for that worker window to start and reopen the terminal.',
    ),
    true,
  );
  assert.equal(
    isRoleWindowMissingError('No active agent context fix-bug for slot runner-browser-2'),
    true,
  );
  assert.equal(
    isRoleWindowMissingError('No active agent role review for slot runner-browser-2'),
    true,
  );
  assert.equal(
    isRoleWindowMissingError('Request terminal.subscribe timed out after 15000ms'),
    false,
  );
  assert.equal(isRoleWindowMissingError(''), false);
});
