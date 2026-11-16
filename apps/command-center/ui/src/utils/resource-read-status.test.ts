import assert from 'node:assert/strict';
import test from 'node:test';

import type { ResourceQueryState } from '@farmslot/protocol/client-cache';

import {
  isExpectedReadAbsence,
  readFailureText,
  readKeepsFailing,
} from './resource-read-status.js';

test('expected observation absence stays neutral beyond the read grace period', () => {
  for (const code of [
    'RESOURCE_OBSERVATION_UNSUPPORTED',
    'RESOURCE_OBSERVATION_UNAVAILABLE',
    'PROGRESS_OWNER_CHANGED',
  ]) {
    for (const data of [undefined, { markdown: '' }]) {
      const state: ResourceQueryState = {
        status: 'error',
        error: { code, message: 'No current source' },
        data,
      };
      const query = { state, failingSince: 1 };
      assert.equal(isExpectedReadAbsence(state), true, code);
      assert.equal(readFailureText(query, 120001), undefined, code);
      assert.equal(readKeepsFailing(query, 120001), false, code);
    }
  }
});

test('actual I/O, parse, access and selected-resource failures stay errors', () => {
  for (const code of [
    'RESOURCE_OBSERVATION_FAILED',
    'EACCES',
    'AUTH_FORBIDDEN',
    'AUTH_REQUIRED',
    'NOT_FOUND',
    'TIMEOUT',
  ]) {
    const state: ResourceQueryState = { status: 'error', error: { code, message: 'Real failure' } };
    assert.equal(isExpectedReadAbsence(state), false, code);
    assert.equal(readFailureText({ state }), 'Real failure', code);
  }
  assert.equal(isExpectedReadAbsence({ status: 'unsupported' }), true);
  assert.equal(
    isExpectedReadAbsence({
      status: 'unsupported',
      error: { code: 'AUTH_REQUIRED', message: 'Sign in' },
    }),
    false,
  );
});
