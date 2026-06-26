import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_RECIPE_PLAYBACK_SLOW_MS,
  recipeRunnerUiOptions,
  recipeRunnerUiOptionsForProject,
} from './recipe-runner-options.js';

test('recipeRunnerUiOptions disables unsupported replay controls by default', () => {
  assert.deepEqual(recipeRunnerUiOptions(null), {
    playbackSlowMs: 0,
    showPlayback: false,
    showRecordVideo: false,
    recordVideo: false,
  });
});

test('recipeRunnerUiOptions enables video-only replay controls', () => {
  assert.deepEqual(
    recipeRunnerUiOptions({
      recipeRunSupportsVideoRecording: true,
    }),
    {
      playbackSlowMs: 0,
      showPlayback: false,
      showRecordVideo: true,
      recordVideo: true,
    },
  );
});

test('recipeRunnerUiOptions enables playback-only replay controls', () => {
  assert.deepEqual(
    recipeRunnerUiOptions({
      recipeRunSupportsPlaybackSlow: true,
    }),
    {
      playbackSlowMs: DEFAULT_RECIPE_PLAYBACK_SLOW_MS,
      showPlayback: true,
      showRecordVideo: false,
      recordVideo: false,
    },
  );
});

test('recipeRunnerUiOptionsForProject resolves by project name', () => {
  assert.equal(
    recipeRunnerUiOptionsForProject('demo', [
      { name: 'demo', recipeRunSupportsPlaybackSlow: true } as any,
    ]).showPlayback,
    true,
  );
});