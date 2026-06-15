import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_CURSOR_MODEL, DEFAULT_GROK_MODEL } from '@farmslot/protocol';

import {
  COMPARISON_LANE_RUNNERS,
  DEFAULT_MODEL,
  EVAL_CANDIDATE_RUNNERS,
  MODELS_BY_RUNNER,
} from './runner-options.js';

test('eval candidates expose Cursor and Grok through the shared comparison runner allowlist', () => {
  assert.equal(COMPARISON_LANE_RUNNERS.has('cursor'), true);
  assert.equal(COMPARISON_LANE_RUNNERS.has('grok'), true);
  assert.equal(EVAL_CANDIDATE_RUNNERS.includes('cursor'), true);
  assert.equal(EVAL_CANDIDATE_RUNNERS.includes('grok'), true);
  assert.deepEqual(MODELS_BY_RUNNER.cursor, [DEFAULT_CURSOR_MODEL]);
  assert.deepEqual(MODELS_BY_RUNNER.grok, [DEFAULT_GROK_MODEL, 'grok-composer-2.5-fast']);
  assert.equal(DEFAULT_MODEL.cursor, DEFAULT_CURSOR_MODEL);
  assert.equal(DEFAULT_MODEL.grok, DEFAULT_GROK_MODEL);
});

test('Claude fable is selectable but not the default model', () => {
  assert.equal(MODELS_BY_RUNNER.claude.includes('fable'), true);
  assert.notEqual(DEFAULT_MODEL.claude, 'fable');
});
