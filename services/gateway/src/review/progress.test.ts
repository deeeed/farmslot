import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, mock, test } from 'node:test';

import * as realChokidar from 'chokidar';
import type { WebSocket } from 'ws';

import type { TaskProgressParams } from '@farmslot/protocol';
import { type ResourceKey, resourceKeyId } from '@farmslot/protocol/client-cache';

import '../runtime/mock-pty.test-support.js';

import { registerNode, unregisterByWs } from '../fleet/machine-registry.js';
import { handleNodeResponse } from '../fleet/node-rpc.js';
import { resourceRevisions } from '../resources/revisions.js';
import { makeVars } from '../runners/test-fixtures.js';
import * as realRunStore from '../runs/store.js';

const watchIds = new Map<string, string>();
const remotePeers: WebSocket[] = [];
afterEach(() => {
  for (const ws of remotePeers) unregisterByWs(ws);
  remotePeers.length = 0;
  watchIds.clear();
});
function remoteVars(machine: string) {
  const ws = {
    readyState: 1,
    send(raw: string) {
      const frame = JSON.parse(raw) as { id: string; method: string; params?: { path?: string } };
      if (frame.method === 'fs.watch') watchIds.set(`${machine}|${frame.params?.path}`, frame.id);
      handleNodeResponse(
        frame.id,
        true,
        {
          watching: true,
          observations: 1,
          initial: { kind: 'updated', content: '' },
        },
        undefined,
        undefined,
        ws,
      );
    },
  } as WebSocket;
  registerNode(
    machine,
    1,
    ws,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { files: 1 },
    () => true,
  );
  remotePeers.push(ws);
  return makeVars({ host: 'runner.example', machine });
}
function watchIdFor(machine: string, file: string): string {
  const id = watchIds.get(`${machine}|${file}`);
  assert(id, 'Use the request registered by the real progress watcher');
  return id;
}

let useActualLocalWriter = false;

let lastTaskProgressParams: TaskProgressParams | null = null;
let updateRunStepError: Error | null = null;
let taskProgressDelay: Promise<void> | null = null;
let closeDelay: Promise<void> | null = null;
let closeFailure: Error | null = null;

mock.module('chokidar', {
  namedExports: {
    watch: (...args: Parameters<typeof realChokidar.watch>) => {
      if (useActualLocalWriter) {
        const watcher = realChokidar.watch(...args);
        return watcher;
      }
      return {
        on(event: string, listener: () => void) {
          if (event === 'ready') queueMicrotask(listener);
          return this;
        },
        async close() {
          if (closeDelay) await closeDelay;
          if (closeFailure) throw closeFailure;
        },
      };
    },
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
    getRun: (id: string) => (useActualLocalWriter ? realRunStore.getRun(id) : { id }),
    shouldUseIsolatedRunsDir: () => false,
    updateRunStep: (...args: Parameters<typeof realRunStore.updateRunStep>) => {
      if (useActualLocalWriter) return realRunStore.updateRunStep(...args);
      if (updateRunStepError) throw updateRunStepError;
    },
  },
});

mock.module('./snapshots.js', {
  namedExports: {
    debugReviewLog: () => {},
  },
});

const { handleReviewFsChanged, initReviewProgress, startProgressWatcher } =
  await import('./progress.js');

test('startProgressWatcher broadcasts reviewer progress for the allocated context id', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'review-progress-'));
  const filePath = path.join(dir, 'REVIEW.md');
  writeFileSync(filePath, '- [x] read\n- [ ] write\n', 'utf-8');
  lastTaskProgressParams = null;
  const events: Array<{ event: string; payload: unknown }> = [];
  initReviewProgress((event, payload) => events.push({ event, payload }));

  const watcher = startProgressWatcher(makeVars(), filePath, 'run-1', 'Review', {
    contextId: 'rev-codex',
    role: 'review',
  });
  await watcher.ready;
  await watcher.stop();
  rmSync(dir, { recursive: true, force: true });

  const params = lastTaskProgressParams as TaskProgressParams | null;
  assert.ok(params);
  assert.equal(params.contextId, 'rev-codex');
  assert.equal(params.role, 'review');
  assert.equal(
    events.some((entry) => {
      const payload = entry.payload as { contextId?: string; role?: string };
      return payload.contextId === 'rev-codex' && payload.role === 'review';
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
    remoteVars('runner-remote'),
    '/remote/REVIEW.md',
    'run-remote',
  );
  try {
    assert.equal(
      handleReviewFsChanged({
        requestId: watchIdFor('runner-remote', '/remote/REVIEW.md'),
        machine: 'runner-remote',
        path: '/remote/REVIEW.md',
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
  initReviewProgress((event) => events.push(event));
  lastTaskProgressParams = null;
  const watcher = startProgressWatcher(
    remoteVars('stale-node'),
    '/remote/stale.md',
    'stale-run',
    'Review',
    { isCurrent: () => false },
  );
  try {
    assert.equal(
      handleReviewFsChanged({
        requestId: watchIdFor('stale-node', '/remote/stale.md'),
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
  const vars = remoteVars('replacement-node');
  const old = startProgressWatcher(vars, '/remote/shared.md', 'same-run');
  const next = startProgressWatcher(vars, '/remote/shared.md', 'same-run');
  lastTaskProgressParams = null;
  try {
    await old.stop();
    assert.equal(
      handleReviewFsChanged({
        requestId: watchIdFor('replacement-node', '/remote/shared.md'),
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
  initReviewProgress((event) => events.push(event));
  let finish!: () => void;
  taskProgressDelay = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const watcher = startProgressWatcher(
    remoteVars('delayed-node'),
    '/remote/delayed.md',
    'delayed-run',
  );
  try {
    handleReviewFsChanged({
      requestId: watchIdFor('delayed-node', '/remote/delayed.md'),
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
  const dir = mkdtempSync(path.join(tmpdir(), 'review-close-'));
  const file = path.join(dir, 'REVIEW.md');
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

test('a remote deletion invalidates only its registered owner and never invents empty progress', async () => {
  const machine = 'owned-delete-node';
  const file = '/remote/owned.md';
  const runId = 'owned-delete-run';
  const events: unknown[] = [];
  initReviewProgress((event) => events.push(event));
  const watcher = startProgressWatcher(remoteVars(machine), file, runId);
  const key = { family: 'progress', runId } as const;
  const before = resourceRevisions.revision(key);
  try {
    assert.equal(
      handleReviewFsChanged({
        requestId: 'foreign-watch',
        machine,
        path: file,
        kind: 'deleted',
        content: '',
      }),
      false,
    );
    assert.equal(resourceRevisions.revision(key), before);
    assert.equal(
      handleReviewFsChanged({
        requestId: watchIdFor(machine, file),
        machine,
        path: file,
        kind: 'deleted',
        content: '',
      }),
      true,
    );
    assert.equal(resourceRevisions.revision(key), before + 1);
    assert.deepEqual(events, [], 'Deletion cannot become a successful 0/0 checklist');
  } finally {
    await watcher.stop();
  }
});

test('the independent local reviewer watch admits its exact context and retires admission on stop', async () => {
  const { assertProgressOwnerAdmitted } = await import('../resources/progress-observations.js');
  const dir = mkdtempSync(path.join(tmpdir(), 'review-owner-admission-'));
  const file = path.join(dir, 'REVIEW.md');
  writeFileSync(file, '- [x] read the diff\n- [ ] report\n');
  const watcher = startProgressWatcher(makeVars(), file, 'review-owner-admission', 'Review', {
    contextId: 'review-allocated',
    role: 'review',
  });
  try {
    await watcher.ready;
    const held = assertProgressOwnerAdmitted('review-owner-admission', 'review-allocated', file);
    held();
    assert.throws(() => assertProgressOwnerAdmitted('review-owner-admission', 'primary', file), {
      code: 'RESOURCE_OBSERVATION_UNAVAILABLE',
    });
    await watcher.stop();
    assert.throws(held, { code: 'RESOURCE_OBSERVATION_CHANGED' });
  } finally {
    await watcher.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

// Observe the actual batched resource.changed payload, not a publication helper.
async function publicationTurn(): Promise<void> {
  const until = Date.now() + 240; // progress publication cadence is 200ms.
  while (Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 10));
}
function changedKeyIds(keys: ResourceKey[]): string[] {
  return [...new Set(keys.map((key) => resourceKeyId(key)))].sort();
}
async function withActualReview(
  work: (file: string, runId: string, slotId: string, keys: ResourceKey[]) => Promise<void>,
) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'review-writer-keys-')));
  const file = path.join(dir, 'REVIEW.md');
  writeFileSync(file, '- [ ] read\n- [ ] write\n');
  useActualLocalWriter = true;
  const run = realRunStore.createRun(
    { flowType: 'dev', project: 'fixture', ticketOrPr: 'REVIEW-KEYS' },
    { deferBackgroundPersist: true },
  );
  run.steps = [{ name: 'review', status: 'running' }];
  const vars = makeVars();
  const keys: ResourceKey[] = [];
  resourceRevisions.setPublisher((payload) => {
    for (const change of payload.changes) keys.push(change.key);
  });
  const watcher = startProgressWatcher(vars, file, run.id, 'Review', { contextId: 'rev-actual' });
  try {
    await watcher.ready;
    await publicationTurn();
    keys.length = 0;
    await work(file, run.id, vars.slotId, keys);
  } finally {
    await watcher.stop();
    await realRunStore.persistRunNow(run, 'drain actual review writer fixture');
    run.status = 'done';
    run.analyticsEmittedAt = new Date().toISOString();
    await realRunStore.deleteRun(run.id);
    resourceRevisions.dispose();
    resourceRevisions.setPublisher(() => {});
    useActualLocalWriter = false;
    rmSync(dir, { recursive: true, force: true });
  }
}

test('actual review tracker write publishes exact progress context and slot keys', async () => {
  await withActualReview(async (file, runId, slotId, keys) => {
    writeFileSync(file, '- [x] read\n- [ ] write\n');
    const until = Date.now() + 2000;
    while (realRunStore.getRun(runId)?.steps[0]?.detail !== 'Review: 1/2 steps') {
      assert.ok(Date.now() < until, 'actual tracker write was not observed');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await realRunStore.persistRunNow(realRunStore.getRun(runId)!, 'assert review tracker commit');
    const disk = JSON.parse(readFileSync(realRunStore.runRecordPath(runId), 'utf8'));
    assert.equal(disk.steps[0].detail, 'Review: 1/2 steps');
    await publicationTurn();
    assert.deepEqual(
      changedKeyIds(keys.filter((key) => key.family === 'progress' || key.family === 'slot')),
      changedKeyIds([
        { family: 'progress', runId },
        { family: 'progress', runId, contextId: 'rev-actual' },
        { family: 'slot', slotId },
      ]),
    );
    assert.ok(
      keys.some((key) => key.family === 'run' && key.runId === runId),
      'actual tracker store mutation also invalidates its run detail',
    );
  });
});
