import assert from 'node:assert/strict';
import test from 'node:test';

import type { CopilotDangerousLaunchBinding } from '@farmslot/protocol';

import {
  copilotRuntimeStatusLabel,
  dangerousLaunchSummary,
  dangerousStartParams,
} from './chat-panel-runtime-model.js';

const binding: CopilotDangerousLaunchBinding = {
  fingerprint: 'bound-fingerprint',
  typedPhrase: 'ENABLE DANGEROUS CO-PILOT',
  warning:
    'Dangerous same-user OS access is not hard containment. Execution permission does not authorize gate approval, publication, merge, release, deletion, cancellation, backlog dispatch, or dispatch expansion.',
  checkout: '/operator/farmslot',
  branch: 'feat/copilot',
  head: 'abc123',
  dirtyFileCount: 7,
  runner: 'cursor',
  model: 'test-model',
  safetyTier: 'dangerous',
};

test('runtime display includes status and all launch-binding metadata', () => {
  assert.equal(copilotRuntimeStatusLabel('running'), 'Running');
  assert.equal(
    dangerousLaunchSummary(binding),
    '/operator/farmslot · feat/copilot · 7 dirty · cursor/test-model',
  );
});

test('dangerous start requires the exact phrase and carries the displayed binding', () => {
  assert.equal(dangerousStartParams(binding, 'wrong'), null);
  assert.deepEqual(dangerousStartParams(binding, binding.typedPhrase), {
    safetyTier: 'dangerous',
    runner: binding.runner,
    model: binding.model,
    confirmation: {
      fingerprint: binding.fingerprint,
      typedPhrase: binding.typedPhrase,
      warningAcknowledged: true,
    },
  });
  for (const boundary of [
    'gate approval',
    'publication',
    'merge',
    'release',
    'deletion',
    'cancellation',
    'backlog dispatch',
    'dispatch expansion',
  ]) {
    assert.match(binding.warning, new RegExp(boundary));
  }
});
