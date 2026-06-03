import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  chatSessionDisplayName,
  clampChatDrawerHeight,
  formatChatInt,
  formatChatUsd,
  normalizeStoredSessionId,
  SHARED_SESSION_ID,
  UNAVAILABLE_REJECT_CODES,
} from './chat-panel-model.js';

test('chat panel session labels and storage normalization preserve legacy behavior', () => {
  assert.equal(normalizeStoredSessionId(null), SHARED_SESSION_ID);
  assert.equal(normalizeStoredSessionId(''), SHARED_SESSION_ID);
  assert.equal(normalizeStoredSessionId('default'), SHARED_SESSION_ID);
  assert.equal(normalizeStoredSessionId('run:abc'), 'run:abc');

  assert.equal(chatSessionDisplayName(SHARED_SESSION_ID), 'Shared chat');
  assert.equal(chatSessionDisplayName('run:123'), 'Run 123');
  assert.equal(chatSessionDisplayName('family:fam-1'), 'Family fam-1');
  assert.equal(chatSessionDisplayName('slot:runner-1'), 'Slot runner-1');
  assert.equal(chatSessionDisplayName('manual-session'), 'manual-session');
});

test('chat panel formatting and drawer clamp stay deterministic', () => {
  assert.equal(formatChatInt(undefined), 'unknown');
  assert.equal(formatChatInt(null), 'unknown');
  assert.equal(formatChatInt(1234.4), '1,234');
  assert.equal(formatChatInt(1234.5), '1,235');

  assert.equal(formatChatUsd(undefined), '$0.0000');
  assert.equal(formatChatUsd(0.123456), '$0.1235');

  assert.equal(clampChatDrawerHeight(100, 900), 320);
  assert.equal(clampChatDrawerHeight(500.4, 900), 500);
  assert.equal(clampChatDrawerHeight(2000, 900), 852);
});

test('chat action reject code set is derived from protocol reasons', () => {
  assert.ok(UNAVAILABLE_REJECT_CODES.has('CHAT_ACTION_REJECT_PRECONDITION_FAIL'));
  assert.ok(UNAVAILABLE_REJECT_CODES.has('CHAT_ACTION_REJECT_EXPIRED'));
});
