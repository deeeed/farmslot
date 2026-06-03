import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_CURSOR_MODEL } from '@farmslot/protocol';

import {
  COMPARISON_LANE_RUNNERS,
  DEFAULT_MODEL,
  EVAL_CANDIDATE_RUNNERS,
  MODELS_BY_RUNNER,
} from './runner-options.js';

test('eval candidates expose Cursor through the shared comparison runner allowlist', () => {
  assert.equal(COMPARISON_LANE_RUNNERS.has('cursor'), true);
  assert.equal(EVAL_CANDIDATE_RUNNERS.includes('cursor'), true);
  assert.deepEqual(MODELS_BY_RUNNER.cursor, [DEFAULT_CURSOR_MODEL]);
  assert.equal(DEFAULT_MODEL.cursor, DEFAULT_CURSOR_MODEL);
});
