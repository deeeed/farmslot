import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';

import { nativeRunnerDefinitions } from './registry.js';

test('cursor review sandbox includes the persist lock directory', () => {
  const roots = nativeRunnerDefinitions.cursor.reviewRuntimeRoots?.({ HOME: '/Users/x' }) ?? [];
  assert.ok(roots.some((root) => root.endsWith('/.cursor')));
  assert.ok(roots.some((root) => root.includes('Application Support/Cursor')));
  if (typeof process.getuid === 'function') {
    assert.ok(roots.includes(join('/tmp', `cursor-agent-persist-${process.getuid()}`)));
  }
});

test('claude review sandbox includes the tool-runner scratch directory', () => {
  const roots = nativeRunnerDefinitions.claude.reviewRuntimeRoots?.({ HOME: '/Users/x' }) ?? [];
  assert.ok(roots.some((root) => root.endsWith('/.claude')));
  if (typeof process.getuid === 'function') {
    assert.ok(roots.includes(join('/tmp', `claude-${process.getuid()}`)));
  }
});
