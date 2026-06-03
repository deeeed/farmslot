import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeRemotePath,
  resolvePathWithinRemoteBase,
  shellExpressionForRemotePath,
} from './remote-paths.js';

test('normalizeRemotePath preserves ~/ roots while normalizing separators', () => {
  assert.equal(normalizeRemotePath('~/repo\\tasks/../tasks/current'), '~/repo/tasks/current');
});

test('resolvePathWithinRemoteBase preserves ~/ roots for nested targets', () => {
  assert.equal(
    resolvePathWithinRemoteBase(
      '~/repo/tasks/current-task/artifacts/recipe-runs/passing-run',
      'recipe-flows/subflow.json',
    ),
    '~/repo/tasks/current-task/artifacts/recipe-runs/passing-run/recipe-flows/subflow.json',
  );
});

test('resolvePathWithinRemoteBase rejects traversal outside the remote base', () => {
  assert.equal(
    resolvePathWithinRemoteBase('~/repo/tasks/current-task', '../other-task/recipe.json'),
    null,
  );
});

test('shellExpressionForRemotePath preserves ~ expansion while remaining shell-safe', () => {
  assert.equal(
    shellExpressionForRemotePath('~/repo/tasks/current-task'),
    '"${HOME}/repo/tasks/current-task"',
  );
  assert.equal(
    shellExpressionForRemotePath('/tmp/repo/tasks/current-task'),
    "'/tmp/repo/tasks/current-task'",
  );
});
