import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  microphonePermissionIsBlocked,
  microphonePermissionSetupState,
} from './audio-permission-state';

test('microphone permission setup reports checking before native state loads', () => {
  const state = microphonePermissionSetupState(null);

  assert.equal(state.status, 'checking');
  assert.equal(state.needsAction, true);
  assert.equal(state.actionLabel, null);
});

test('microphone permission setup accepts granted access', () => {
  const state = microphonePermissionSetupState({ status: 'granted', granted: true });

  assert.equal(state.status, 'ready');
  assert.equal(state.needsAction, false);
  assert.equal(state.actionLabel, null);
});

test('microphone permission setup asks in app when permission can be requested', () => {
  const state = microphonePermissionSetupState({
    status: 'undetermined',
    granted: false,
    canAskAgain: true,
  });

  assert.equal(state.status, 'required');
  assert.equal(state.actionLabel, 'Allow Microphone');
  assert.equal(state.blocked, false);
});

test('microphone permission setup directs blocked users to system settings', () => {
  const state = microphonePermissionSetupState({
    status: 'denied',
    granted: false,
    canAskAgain: false,
  });

  assert.equal(state.status, 'blocked');
  assert.equal(state.actionLabel, 'Open App Settings');
  assert.equal(state.blocked, true);
  assert.match(state.body, /Open system settings/);
});

test('microphone permission setup treats skipped denied state as blocked', () => {
  const permission = {
    status: 'denied',
    granted: false,
  };
  const state = microphonePermissionSetupState(permission);

  assert.equal(microphonePermissionIsBlocked(permission), true);
  assert.equal(state.status, 'blocked');
  assert.equal(state.actionLabel, 'Open App Settings');
});

test('microphone permission setup keeps requestable denied state in-app', () => {
  const permission = {
    status: 'denied',
    granted: false,
    canAskAgain: true,
  };
  const state = microphonePermissionSetupState(permission);

  assert.equal(microphonePermissionIsBlocked(permission), false);
  assert.equal(state.status, 'required');
  assert.equal(state.actionLabel, 'Allow Microphone');
});
