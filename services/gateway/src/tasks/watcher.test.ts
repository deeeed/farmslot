import assert from 'node:assert/strict';
import test from 'node:test';

import {
  bindWorkerSignalToWatch,
  resolveContextFilePath,
  shouldRebindWatch,
  slotIdFromWatchKey,
  watchKey,
} from './watcher.js';

test('resolveContextFilePath resolves relative paths inside the repo', () => {
  assert.equal(
    resolveContextFilePath('/repo/worktree', '.task/fix/TASK.md', '/repo/worktree/default/TASK.md'),
    '/repo/worktree/.task/fix/TASK.md',
  );
});

test('resolveContextFilePath resolves sibling signal files beside task files', () => {
  assert.equal(
    resolveContextFilePath(
      '/repo/worktree',
      'SIGNAL.json',
      '/repo/worktree/default/SIGNAL.json',
      '/repo/worktree/.task/fix/TASK.md',
    ),
    '/repo/worktree/.task/fix/SIGNAL.json',
  );
});

test('resolveContextFilePath treats bare paths without sibling context as fallback-only', () => {
  assert.equal(
    resolveContextFilePath('/repo/worktree', 'TASK.md', '/repo/worktree/.task/fix/TASK.md'),
    '/repo/worktree/.task/fix/TASK.md',
  );
});

test('resolveContextFilePath rejects relative traversal', () => {
  assert.throws(
    () =>
      resolveContextFilePath(
        '/repo/worktree',
        '../outside/TASK.md',
        '/repo/worktree/default/TASK.md',
      ),
    /escapes repo/,
  );
});

test('resolveContextFilePath rejects absolute paths outside the repo', () => {
  assert.throws(
    () =>
      resolveContextFilePath('/repo/worktree', '/tmp/TASK.md', '/repo/worktree/default/TASK.md'),
    /escapes repo/,
  );
});

test('watch keys keep colon-bearing context ids intact', () => {
  assert.equal(watchKey('runner-browser-1', 'ctx:review:1'), 'runner-browser-1:ctx:review:1');
  assert.equal(slotIdFromWatchKey('runner-browser-1:ctx:review:1'), 'runner-browser-1');
});

test('watch keys reject colon-bearing slot ids before parsing can corrupt identity', () => {
  assert.throws(() => watchKey('runner-local:mme-1', 'review'), /Invalid slot id/);
});

test('watch identity rebinds when a slot/context is reused by another run', () => {
  const current = {
    runId: 'run-a',
    taskFilePath: '/repo/.task/fix/a/TASK.md',
    signalFilePath: '/repo/.task/fix/a/SIGNAL.json',
  };
  assert.equal(shouldRebindWatch(current, { ...current }), false);
  assert.equal(shouldRebindWatch(current, { ...current, runId: 'run-b' }), true);
  assert.equal(
    shouldRebindWatch(current, { ...current, taskFilePath: '/repo/.task/fix/b/TASK.md' }),
    true,
  );
  assert.equal(
    shouldRebindWatch(current, { ...current, signalFilePath: '/repo/.task/fix/b/SIGNAL.json' }),
    true,
  );
});

test('bindWorkerSignalToWatch keeps watcher role/context authoritative', () => {
  const bound = bindWorkerSignalToWatch(
    'runner-browser-1:self-review-fix',
    {
      status: 'complete',
      timestamp: '2026-04-26T00:00:00Z',
      role: undefined,
      contextId: undefined,
    },
    'self-review-fix',
    'self-review-fix',
  );
  assert.equal(bound?.role, 'self-review-fix');
  assert.equal(bound?.contextId, 'self-review-fix');
  assert.equal(bound?.signal.role, 'self-review-fix');
  assert.equal(bound?.signal.contextId, 'self-review-fix');
});

test('bindWorkerSignalToWatch rejects mismatched worker role/context tags', () => {
  assert.equal(
    bindWorkerSignalToWatch(
      'runner-browser-1:self-review-fix',
      { status: 'complete', timestamp: '2026-04-26T00:00:00Z', role: 'primary' },
      'self-review-fix',
      'self-review-fix',
    ),
    null,
  );
  assert.equal(
    bindWorkerSignalToWatch(
      'runner-browser-1:self-review-fix',
      { status: 'complete', timestamp: '2026-04-26T00:00:00Z', contextId: 'review' },
      'self-review-fix',
      'self-review-fix',
    ),
    null,
  );
});
