import assert from 'node:assert/strict';
import test from 'node:test';

import type { Run } from '@farmslot/protocol';

import { completionVerificationMode } from './push-verification.js';

const shape = (over: Partial<Run>): Run =>
  ({ flowType: 'dev', mode: 'autonomous', ...over }) as Run;

test('worker-owned-push flows require a published branch', () => {
  assert.equal(completionVerificationMode(shape({ flowType: 'pr-complete' })), 'push');
  assert.equal(completionVerificationMode(shape({ flowType: 'update-branch' })), 'push');
});

test('autonomous dev requires a commit but not a push', () => {
  // The publication step performs the push, so requiring one here would fire
  // before it is meant to. Uncommitted work is the real loss: it exists only in
  // the slot worktree. Run 32909fa2 completed with 26 files uncommitted.
  assert.equal(completionVerificationMode(shape({ flowType: 'dev' })), 'commit');
});

test('interactive dev is operator-owned and verified elsewhere', () => {
  // The template tells the worker to keep changes local unless told otherwise, so
  // neither a commit nor a push can be demanded of it here.
  assert.equal(
    completionVerificationMode(
      shape({ flowType: 'dev', mode: 'interactive', devInteractiveProfile: 'lightweight' }),
    ),
    'none',
  );
  assert.equal(
    completionVerificationMode(
      shape({ flowType: 'dev', mode: 'interactive', devInteractiveProfile: 'reviewed' }),
    ),
    'none',
  );
});

test('unrelated flows are not gated', () => {
  assert.equal(completionVerificationMode(shape({ flowType: 'fix-bug' })), 'none');
  assert.equal(completionVerificationMode(shape({ flowType: 'review-pr' })), 'none');
});
