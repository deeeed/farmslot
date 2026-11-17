import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TASK_DIRECTORY_LAYOUT,
  TASK_DIRECTORY_LAYOUT_VERSION,
  TASK_FILE_SCHEMAS,
  type TaskDirectoryFileId,
} from './task-layout.js';

test('task actions have the documented canonical root and a manifest format', () => {
  assert.equal(TASK_DIRECTORY_LAYOUT_VERSION, 1);
  assert.equal(TASK_DIRECTORY_LAYOUT.taskActions.relativePath, 'artifacts/task-actions');
  assert.equal(
    TASK_DIRECTORY_LAYOUT.taskActionManifests.relativePath,
    'artifacts/task-actions/manifests',
  );
  assert.equal(
    TASK_DIRECTORY_LAYOUT.taskActionImplementations.relativePath,
    'artifacts/task-actions/actions',
  );
  assert.equal(
    TASK_FILE_SCHEMAS[TASK_DIRECTORY_LAYOUT.taskActionManifest.schema].reference,
    'https://farmslot.io/schemas/action-manifest-v1.schema.json',
  );
  const roots: string[] = Object.values(TASK_DIRECTORY_LAYOUT).map(
    ({ relativePath }) => relativePath,
  );
  assert.ok(!roots.includes('task-actions'));
});

test('every reserved task path is relative, unique and has a named format authority', () => {
  const paths = Object.values(TASK_DIRECTORY_LAYOUT).map(({ relativePath, schema }) => {
    assert.ok(relativePath.length > 0 && !relativePath.startsWith('/'));
    assert.ok(!relativePath.split('/').includes('..'));
    assert.ok(TASK_FILE_SCHEMAS[schema].reference);
    return relativePath;
  });
  assert.equal(new Set(paths).size, paths.length);
  // @ts-expect-error Unknown files cannot be selected from the contract.
  const unsupported: TaskDirectoryFileId = 'task-actions-fallback';
  void unsupported;
});
