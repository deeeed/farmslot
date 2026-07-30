import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_CODEX_MODEL, DEFAULT_CURSOR_MODEL, DEFAULT_GROK_MODEL } from '@farmslot/protocol';

import {
  COMPARISON_LANE_RUNNERS,
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  EVAL_CANDIDATE_RUNNERS,
  modelForRunnerChange,
  MODELS_BY_RUNNER,
  modelsForRunner,
} from './runner-options.js';

test('eval candidates expose Cursor and Grok through the shared comparison runner allowlist', () => {
  assert.equal(COMPARISON_LANE_RUNNERS.has('cursor'), true);
  assert.equal(COMPARISON_LANE_RUNNERS.has('grok'), true);
  assert.equal(EVAL_CANDIDATE_RUNNERS.includes('cursor'), true);
  assert.equal(EVAL_CANDIDATE_RUNNERS.includes('grok'), true);
  assert.deepEqual(MODELS_BY_RUNNER.cursor, [
    DEFAULT_CURSOR_MODEL,
    'composer-2.5-fast',
    'cursor-grok-4.5-high-fast',
    'cursor-grok-4.5-high',
  ]);
  assert.deepEqual(MODELS_BY_RUNNER.grok, [DEFAULT_GROK_MODEL]);
  assert.equal(DEFAULT_MODEL.cursor, DEFAULT_CURSOR_MODEL);
  assert.equal(MODELS_BY_RUNNER.cursor.includes('grok-4.5-fast-xhigh'), false);
  assert.equal(MODELS_BY_RUNNER.cursor.includes('cursor-grok-4.5-high-fast'), true);
  assert.equal(DEFAULT_MODEL.grok, DEFAULT_GROK_MODEL);
});

test('Claude fable is selectable but not the default model', () => {
  assert.equal(MODELS_BY_RUNNER.claude.includes('fable'), true);
  assert.notEqual(DEFAULT_MODEL.claude, 'fable');
});

test('modelsForRunner returns only that runner allowlist — no cross-runner bleed', () => {
  assert.deepEqual(modelsForRunner('codex'), [
    DEFAULT_CODEX_MODEL,
    'gpt-5.6-terra',
    'gpt-5.6-luna',
    'gpt-5.5',
    'gpt-5.4',
  ]);
  assert.deepEqual(modelsForRunner('claude'), ['sonnet', 'opus', 'haiku', 'fable']);
  assert.equal(modelsForRunner('codex').includes('opus'), false);
  assert.equal(modelsForRunner('codex').includes('grok-build'), false);
  assert.equal(modelsForRunner('claude').includes('gpt-5.5'), false);
  assert.deepEqual(modelsForRunner('unknown-runner'), []);
});

test('Codex defaults to GPT-5.6 Sol and exposes the full 5.6 family', () => {
  assert.equal(DEFAULT_MODEL.codex, DEFAULT_CODEX_MODEL);
  assert.equal(DEFAULT_CODEX_MODEL, 'gpt-5.6-sol');
  assert.equal(MODELS_BY_RUNNER.codex.includes('gpt-5.6-sol'), true);
  assert.equal(MODELS_BY_RUNNER.codex.includes('gpt-5.6-terra'), true);
  assert.equal(MODELS_BY_RUNNER.codex.includes('gpt-5.6-luna'), true);
});

test('Codex and Grok default effort is xhigh when omitted', () => {
  assert.equal(DEFAULT_EFFORT.codex, 'xhigh');
  assert.equal(DEFAULT_EFFORT.grok, 'xhigh');
  assert.equal(DEFAULT_EFFORT.cursor, '');
  assert.equal(DEFAULT_EFFORT.claude, '');
});

test('modelForRunnerChange clears or remaps invalid models when the runner changes', () => {
  // Keep a still-valid model.
  assert.equal(modelForRunnerChange('codex', 'gpt-5.4'), 'gpt-5.4');
  assert.equal(modelForRunnerChange('codex', 'gpt-5.6-terra'), 'gpt-5.6-terra');
  // Claude model is invalid for codex → codex default.
  assert.equal(modelForRunnerChange('codex', 'opus'), DEFAULT_MODEL.codex);
  assert.equal(modelForRunnerChange('claude', 'gpt-5.5'), DEFAULT_MODEL.claude);
  // Empty runner with defaultRunner: keep only if valid for that default.
  assert.equal(modelForRunnerChange('', 'gpt-5.6-sol', { defaultRunner: 'codex' }), 'gpt-5.6-sol');
  assert.equal(modelForRunnerChange('', 'opus', { defaultRunner: 'codex' }), '');
  // Empty runner without defaultRunner always clears.
  assert.equal(modelForRunnerChange('', 'gpt-5.5'), '');
  // Empty current model → runner default when a runner is selected.
  assert.equal(modelForRunnerChange('grok', ''), DEFAULT_MODEL.grok);
});
