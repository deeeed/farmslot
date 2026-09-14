import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';

import type { TaskProgressParams } from '@farmslot/protocol';

import { makeVars } from '../runners/test-fixtures.js';

let lastTaskProgressParams: TaskProgressParams | null = null;
let updateRunStepError: Error | null = null;
let taskProgressDelay: Promise<void> | null = null;
let closeDelay: Promise<void> | null = null;
let closeFailure: Error | null = null;

mock.module('chokidar', {
  namedExports: {
    watch: () => ({
      on() {
        return this;
      },
      async close() {
        if (closeDelay) await closeDelay;
        if (closeFailure) throw closeFailure;
      },
    }),
  },
});

mock.module('../methods/task.js', {
  namedExports: {
    taskProgress: async (params: TaskProgressParams) => {
      lastTaskProgressParams = params;
      if (taskProgressDelay) await taskProgressDelay;
      return {
        slotId: params.slotId,
        role: params.role,
        contextId: params.contextId,
        markdown: '',
      };
    },
  },
});

mock.module('../runs/store.js', {
  namedExports: {
    getRun: (id: string) => ({ id }),
    shouldUseIsolatedRunsDir: () => false,
    updateRunStep: () => {
      if (updateRunStepError) throw updateRunStepError;
    },
  },
});

mock.module('./snapshots.js', {
  namedExports: {
    debugSelfReviewLog: () => {},
  },
});

const { handleSelfReviewFsChanged, initSelfReviewProgress, startProgressWatcher } =
  await import('./progress.js');

test('startProgressWatcher broadcasts reviewer progress for the allocated context id', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'self-review-progress-'));
  const filePath = path.join(dir, 'SELF-REVIEW.md');
  writeFileSync(filePath, '- [x] read\n- [ ] write\n', 'utf-8');
  lastTaskProgressParams = null;
  const events: Array<{ event: string; payload: unknown }> = [];
  initSelfReviewProgress((event, payload) => events.push({ event, payload }));

  const watcher = startProgressWatcher(makeVars(), filePath, 'run-1', 'Review', {
    contextId: 'rev-codex',
    role: 'self-review',
  });
  await watcher.ready;
  await watcher.stop();
  rmSync(dir, { recursive: true, force: true });

  const params = lastTaskProgressParams as TaskProgressParams | null;
  assert.ok(params);
  assert.equal(params.contextId, 'rev-codex');
  assert.equal(params.role, 'self-review');
  assert.equal(
    events.some((entry) => {
      const payload = entry.payload as { contextId?: string; role?: string };
      return payload.contextId === 'rev-codex' && payload.role === 'self-review';
    }),
    true,
  );
});

test('remote progress callback contains asynchronous update failures', async () => {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (message?: unknown) => warnings.push(String(message));
  updateRunStepError = new Error('run store unavailable');
  const watcher = startProgressWatcher(
    makeVars({ host: 'runner.example', machine: 'runner-remote' }),
    '/remote/SELF-REVIEW.md',
    'run-remote',
  );
  try {
    assert.equal(
      handleSelfReviewFsChanged({
        machine: 'runner-remote',
        path: '/remote/SELF-REVIEW.md',
        content: '- [x] read\n',
      }),
      true,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(
      warnings.some((warning) => warning.includes('run store unavailable')),
      true,
    );
  } finally {
    await watcher.stop();
    updateRunStepError = null;
    console.warn = originalWarn;
  }
});

test('superseded remote progress emits no run or task updates', async () => {
  const events: unknown[] = [];
  initSelfReviewProgress((event) => events.push(event));
  lastTaskProgressParams = null;
  const watcher = startProgressWatcher(
    makeVars({ host: 'runner.example', machine: 'stale-node' }),
    '/remote/stale.md',
    'stale-run',
    'Review',
    { isCurrent: () => false },
  );
  try {
    assert.equal(
      handleSelfReviewFsChanged({
        machine: 'stale-node',
        path: '/remote/stale.md',
        content: '- [x] stale\n',
      }),
      true,
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(events, []);
    assert.equal(lastTaskProgressParams, null);
  } finally {
    await watcher.stop();
  }
});

test('stopping an older remote watcher preserves the replacement registered at the same path', async () => {
  const vars = makeVars({ host: 'runner.example', machine: 'replacement-node' });
  const old = startProgressWatcher(vars, '/remote/shared.md', 'same-run');
  const next = startProgressWatcher(vars, '/remote/shared.md', 'same-run');
  lastTaskProgressParams = null;
  try {
    await old.stop();
    assert.equal(
      handleSelfReviewFsChanged({
        machine: 'replacement-node',
        path: '/remote/shared.md',
        content: '- [x] current\n',
      }),
      true,
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(lastTaskProgressParams);
  } finally {
    await old.stop();
    await next.stop();
  }
});

test('a stopped watcher cannot publish a task read that completes later', async () => {
  const events: string[] = [];
  initSelfReviewProgress((event) => events.push(event));
  let finish!: () => void;
  taskProgressDelay = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const watcher = startProgressWatcher(
    makeVars({ host: 'runner.example', machine: 'delayed-node' }),
    '/remote/delayed.md',
    'delayed-run',
  );
  try {
    handleSelfReviewFsChanged({
      machine: 'delayed-node',
      path: '/remote/delayed.md',
      content: '- [x] done\n',
    });
    await watcher.stop();
    const before = [...events];
    finish();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(events, before);
  } finally {
    finish();
    taskProgressDelay = null;
    await watcher.stop();
  }
});

test('stop waits for local watcher closure and exposes asynchronous failure', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'self-review-close-'));
  const file = path.join(dir, 'SELF-REVIEW.md');
  writeFileSync(file, '- [ ] review\n');
  const watcher = startProgressWatcher(makeVars(), file, 'close-run');
  let release!: () => void;
  let finished = false;
  try {
    await watcher.ready;
    closeDelay = new Promise<void>((resolve) => {
      release = resolve;
    });
    closeFailure = new Error('asynchronous watcher close failed');
    const stopped = watcher.stop().then(
      () => {
        finished = true;
      },
      (error) => {
        finished = true;
        throw error;
      },
    );
    const rejected = assert.rejects(stopped, /asynchronous watcher close failed/);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(finished, false);
    release();
    await rejected;
  } finally {
    release?.();
    closeDelay = null;
    closeFailure = null;
    await watcher.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
