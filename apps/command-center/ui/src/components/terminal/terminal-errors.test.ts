import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isRetiredTerminalTargetError,
  isRetryableTerminalSubscribeError,
} from './terminal-errors.js';

test('retired targets are terminal failures even when the message suggests retry', () => {
  const error = Object.assign(new Error('timeout; wait for the worker'), {
    code: 'TERMINAL_TARGET_RETIRED',
  });
  assert.equal(isRetiredTerminalTargetError(error), true);
  assert.equal(isRetryableTerminalSubscribeError(error), false);
});

test('pending targets use the gateway code independently of message wording', () => {
  const error = Object.assign(new Error('Window still starting'), {
    code: 'TERMINAL_TARGET_PENDING',
  });
  assert.equal(isRetiredTerminalTargetError(error), false);
  assert.equal(isRetryableTerminalSubscribeError(error), true);
});

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
