import assert from 'node:assert/strict';
import test from 'node:test';

import { nativeConversationError } from './native-conversation-error';

const errors = { action: '', read: 'Connection closed', creation: '', resume: '' };

// Review r1: the raw read error stacked under the "Offline" heading.
test('offline, a native conversation keeps its own errors and drops the read the outage failed', () => {
  assert.equal(nativeConversationError(errors, false, true), '');
  assert.equal(nativeConversationError(errors, true, true), 'Connection closed');
  const denied = { ...errors, read: 'This account cannot open a farm worker conversation.' };
  assert.equal(nativeConversationError(denied, false, false), denied.read, 'A refusal still shows');
  const failedSend = { ...errors, action: 'Could not save the draft' };
  assert.equal(nativeConversationError(failedSend, false, true), 'Could not save the draft');
  assert.equal(
    nativeConversationError({ ...errors, resume: 'Resume refused' }, false, true),
    'Resume refused',
  );
});
