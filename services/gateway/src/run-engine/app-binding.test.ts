import assert from 'node:assert/strict';
import test from 'node:test';

import { appBindingMismatch, type ProjectAppDefaults } from './app-binding.js';

const audiolab: ProjectAppDefaults = {
  recipe: { app: 'apps/playground' },
  apps: ['apps/playground', 'apps/sherpa-voice', 'apps/minimal'],
};

test('a run that names no app is never a mismatch', () => {
  for (const runApp of [undefined, null, '', '  '])
    assert.equal(appBindingMismatch(runApp, 'apps/playground', audiolab), null);
});

test('apps that differ only by ./, a trailing / or spaces agree', () => {
  assert.equal(appBindingMismatch(' ./apps/sherpa-voice/ ', 'apps/sherpa-voice', audiolab), null);
});

test('a pool slot bound to another app is a slot mismatch', () => {
  assert.deepEqual(appBindingMismatch('apps/sherpa-voice', 'apps/playground', audiolab), {
    runApp: 'apps/sherpa-voice',
    slotApp: 'apps/playground',
    source: 'slot',
  });
});

test('a slot without an app is bound to the project default', () => {
  assert.deepEqual(appBindingMismatch('apps/sherpa-voice', undefined, audiolab), {
    runApp: 'apps/sherpa-voice',
    slotApp: 'apps/playground',
    source: 'project',
  });
  assert.deepEqual(
    appBindingMismatch('apps/sherpa-voice', undefined, { apps: ['apps/playground/'] }),
    {
      runApp: 'apps/sherpa-voice',
      slotApp: 'apps/playground',
      source: 'project',
    },
  );
});

test('a slot with no app and no project default has no binding to compare', () => {
  assert.equal(appBindingMismatch('apps/sherpa-voice', undefined, { apps: audiolab.apps }), null);
});
