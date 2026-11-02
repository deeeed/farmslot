import assert from 'node:assert/strict';
import test from 'node:test';

import { appBindingMismatch, type SlotAppBinding } from './app-binding.js';

const audiolab: Omit<SlotAppBinding, 'slotApp'> = {
  recipeApp: 'apps/playground',
  apps: ['apps/playground', 'apps/sherpa-voice', 'apps/minimal'],
};

test('a run that names no app is never a mismatch', () => {
  for (const runApp of [undefined, null, '', '  '])
    assert.equal(appBindingMismatch(runApp, { ...audiolab, slotApp: 'apps/playground' }), null);
});

test('apps that differ only by ./, a trailing / or spaces agree', () => {
  assert.equal(
    appBindingMismatch(' ./apps/sherpa-voice/ ', { ...audiolab, slotApp: 'apps/sherpa-voice' }),
    null,
  );
});

test('a pool slot bound to another app is a slot mismatch', () => {
  assert.deepEqual(
    appBindingMismatch('apps/sherpa-voice', { ...audiolab, slotApp: 'apps/playground' }),
    {
      runApp: 'apps/sherpa-voice',
      slotApp: 'apps/playground',
      source: 'slot',
    },
  );
});

test('a slot without an app is bound to the project default', () => {
  assert.deepEqual(appBindingMismatch('apps/sherpa-voice', { ...audiolab, slotApp: undefined }), {
    runApp: 'apps/sherpa-voice',
    slotApp: 'apps/playground',
    source: 'project',
  });
  assert.deepEqual(
    appBindingMismatch('apps/sherpa-voice', {
      slotApp: undefined,
      recipeApp: undefined,
      apps: ['apps/playground/'],
    }),
    { runApp: 'apps/sherpa-voice', slotApp: 'apps/playground', source: 'project' },
  );
});

test('a slot with no app and no project default has no binding to compare', () => {
  assert.equal(
    appBindingMismatch('apps/sherpa-voice', {
      slotApp: undefined,
      recipeApp: undefined,
      apps: audiolab.apps,
    }),
    null,
  );
});
