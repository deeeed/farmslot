import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clearVisibleModels,
  onVisibleModelsChange,
  rememberedDefaultModel,
  rememberedVisibleModels,
  rememberVisibleModels,
} from './runner-visible-cache.js';

test('visible model changes notify mounted consumers and disconnect clears cached preferences', () => {
  clearVisibleModels();
  let calls = 0;
  const unsubscribe = onVisibleModelsChange(() => {
    calls++;
  });
  try {
    rememberVisibleModels('cursor', ['auto']);
    assert.equal(calls, 1);
    rememberVisibleModels('cursor', ['auto']);
    assert.equal(calls, 1);
    assert.deepEqual(rememberedVisibleModels('cursor'), ['auto']);
    clearVisibleModels();
    assert.equal(calls, 2);
    assert.equal(rememberedVisibleModels('cursor'), null);
    rememberVisibleModels('cursor', ['auto'], 'composer-2.5');
    assert.equal(rememberedDefaultModel('cursor'), 'composer-2.5');
    rememberVisibleModels('cursor', ['auto'], 'claude-opus-5-5-high');
    assert.equal(rememberedDefaultModel('cursor'), 'claude-opus-5-5-high');
    clearVisibleModels();
    assert.equal(rememberedDefaultModel('cursor'), undefined);
  } finally {
    unsubscribe();
    clearVisibleModels();
  }
});
