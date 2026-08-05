import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';

import type { TaskProgressParams } from '@farmslot/protocol';

import { makeVars } from '../runners/test-fixtures.js';

let lastTaskProgressParams: TaskProgressParams | null = null;
let updateRunStepError: Error | null = null;

mock.module('chokidar', {
  namedExports: {
    watch: () => ({
      on() {
        return this;
      },
      close() {},
    }),
  },
});

mock.module('../methods/task.js', {
  namedExports: {
    taskProgress: async (params: TaskProgressParams) => {
      lastTaskProgressParams = params;
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
  watcher.stop();
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
    watcher.stop();
    updateRunStepError = null;
    console.warn = originalWarn;
  }
});
