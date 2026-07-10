import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';

import type { TaskProgressParams } from '@farmslot/protocol';

import { makeVars } from '../runners/test-fixtures.js';

let lastTaskProgressParams: TaskProgressParams | null = null;

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
    updateRunStep: () => {},
  },
});

mock.module('./snapshots.js', {
  namedExports: {
    debugSelfReviewLog: () => {},
  },
});

const { initSelfReviewProgress, startProgressWatcher } = await import('./progress.js');

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
  await new Promise((resolve) => setTimeout(resolve, 25));
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
