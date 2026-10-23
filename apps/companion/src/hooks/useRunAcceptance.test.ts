import assert from 'node:assert/strict';
import test from 'node:test';
import { URL } from 'node:url';

import { Events, Methods } from '@farmslot/protocol';
import {
  createGatewayResourceCache,
  type ResourceQuery,
  resourceQuery,
} from '@farmslot/protocol/client-cache';

import { ResourceCacheConformanceTransport } from '../../../../packages/protocol/src/client-cache/conformance';
import { recordVisualClaimReview } from '../lib/visual-claim-review';

import { mountHook } from './hook-harness.fixtures';
import type { RunAcceptanceSource } from './useRunAcceptance';

const run: RunAcceptanceSource = {
  id: 'fixture-run',
  slotId: 'fixture-slot',
  updatedAt: '2026-10-16T00:00:00Z',
};
const progress = { acceptanceCriteria: [], acceptanceStatus: { schemaVersion: 2, criteria: [] } };

/** Execute the actual hook with deterministic React scheduling and a read-only transport stub. */
function mount(request: (method: string) => Promise<unknown>) {
  let connection: number | null = 1;
  let progressRevision = 0;
  let artifactsRevision = 0;
  const transport = new ResourceCacheConformanceTransport({
    gatewayUrl: 'ws://acceptance.invalid/',
  });
  transport.setConnection({ connected: true, id: 1 });
  transport.request = async <T>(method: Parameters<typeof resourceQuery>[0], params: unknown) => {
    const dependencies = resourceQuery(method, params).dependencies.map((key) => ({
      key,
      revision:
        key.family === 'progress'
          ? progressRevision
          : key.family === 'artifacts'
            ? artifactsRevision
            : 0,
    }));
    return {
      data: (method === Methods.RUN_GET ? { run } : await request(method)) as T,
      resourceState: { epoch: 'conformance-epoch', dependencies },
    };
  };
  const cache = createGatewayResourceCache({ transport });
  const observers = new Map<string, () => void>();
  const client = {
    request,
    subscribe: () => () => undefined,
    authenticatedPrincipal: null,
    connectionState: 'connected',
  };
  const hook = mountHook<[typeof client, RunAcceptanceSource]>(
    new URL('./useRunAcceptance.ts', import.meta.url),
    'useRunAcceptance',
    {
      '@farmslot/protocol': { Methods, Events },
      '@farmslot/protocol/client-cache': { resourceQuery },
      './useResourceQuery': {
        useResourceQuery<T>(query: ResourceQuery<T> | undefined) {
          if (!query) return { status: 'loading' };
          if (!observers.has(query.id))
            observers.set(
              query.id,
              cache.observe(query, () => {}),
            );
          return cache.read(query);
        },
      },
      '../lib/resource-cache': { getResourceCache: () => cache },
      '../lib/run-collections': {
        assertNativeRunReady: () => {
          throw new Error('No command expected in acceptance-read tests');
        },
      },
      '@farmslot/adapter-sdk/evidence': {
        createEvidenceReviewModel: () => null,
        runEvidencePending: () => false,
      },
      '../lib/recoverable-errors': { isGatewayBackgroundPauseError: () => false },
      '../lib/visual-claim-review': { recordVisualClaimReview },
      '../lib/task-progress': {
        taskProgressRequestForRun: () => ({ runId: run.id, slotId: run.slotId }),
        taskProgressUpdateTargetsRun: () => false,
      },
      '../lib/task-progress-view': { acceptanceLedgerView: () => ({ rows: [] }) },
      '../store/connection': {
        useConnectionStore: (select: (state: { authorityEpoch: number }) => unknown) =>
          select({ authorityEpoch: 1 }),
      },
      './useConnectedTransport': { useConnectedTransport: () => connection },
    },
  );
  return {
    render(input = run): Record<string, unknown> {
      const result = hook.render(client, input);
      assert.ok(typeof result === 'object' && result !== null);
      if (typeof result !== 'object' || result === null) throw new Error('Invalid hook result');
      return Object.fromEntries(Object.entries(result));
    },
    setConnected(connected: boolean) {
      connection = connected ? 1 : null;
      client.connectionState = connected ? 'connected' : 'disconnected';
      transport.setConnection({ connected, id: connected ? 2 : 1 });
    },
    invalidateEvidence() {
      artifactsRevision++;
      transport.publish({
        version: 1,
        epoch: 'conformance-epoch',
        changes: [
          {
            key: { family: 'artifacts', runId: run.id },
            revision: artifactsRevision,
            kind: 'updated',
          },
        ],
      });
    },
    invalidateProgress() {
      progressRevision++;
      transport.publish({
        version: 1,
        epoch: 'conformance-epoch',
        changes: [
          {
            key: { family: 'progress', runId: run.id },
            revision: progressRevision,
            kind: 'updated',
          },
        ],
      });
    },
    async cleanup() {
      hook.cleanup();
      for (const stop of observers.values()) stop();
      await cache.dispose();
    },
  };
}
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

function retry(result: Record<string, unknown>) {
  assert.equal(typeof result.retry, 'function');
  if (typeof result.retry !== 'function') throw new Error('Retry callback missing');
  result.retry();
}

test('cold Retry shows loading until the unchanged run acceptance read arrives', async (t) => {
  let reads = 0;
  let evidenceReads = 0;
  let finish: (result: unknown) => void = () => assert.fail('retry did not start');
  const pending = new Promise<unknown>((resolve) => {
    finish = resolve;
  });
  const mounted = mount(async (method) => {
    if (method === Methods.TASK_PROGRESS) {
      if (++reads === 1) throw new Error('temporary read failure');
      return pending;
    }
    assert.equal(method, Methods.RUN_RECIPE_RUNS_FOR_RUN);
    evidenceReads++;
    return { recipeRuns: [], selectedRecipeRunId: null };
  });
  t.after(mounted.cleanup);
  mounted.render();
  await settle();
  const failed = mounted.render();
  assert.match(String(failed.error), /temporary read failure/);
  assert.equal(failed.loading, false);
  mounted.render({ ...run });
  await settle();
  assert.equal(reads, 1);
  retry(failed);
  await settle();
  const waiting = mounted.render();
  assert.equal(waiting.error, null, 'A cold Retry must clear its old request error while loading');
  assert.equal(waiting.view, null);
  assert.equal(waiting.loading, true);
  assert.equal(waiting.evidenceModel, null);
  await settle();
  assert.equal(reads, 2);
  finish(progress);
  await settle();
  assert.equal(
    evidenceReads,
    2,
    'Explicit Retry rereads the shared evidence query as well as criteria',
  );
  assert.equal(mounted.render().error, null);
  assert.notEqual(mounted.render().view, null);
});

test('Retry preserves a cached acceptance read and its error until the refresh arrives', async (t) => {
  let reads = 0;
  let finish: (result: unknown) => void = () => assert.fail('retry did not start');
  const pending = new Promise<unknown>((resolve) => {
    finish = resolve;
  });
  const mounted = mount(async (method) => {
    if (method === Methods.TASK_PROGRESS) {
      if (++reads === 1) return progress;
      if (reads === 2) throw new Error('temporary refresh failure');
      return pending;
    }
    assert.equal(method, Methods.RUN_RECIPE_RUNS_FOR_RUN);
    return { recipeRuns: [], selectedRecipeRunId: null };
  });
  t.after(mounted.cleanup);
  mounted.render();
  await settle();
  const loaded = mounted.render();
  assert.notEqual(loaded.view, null);
  assert.equal(loaded.loading, false);
  retry(loaded);
  mounted.render();
  await settle();
  const failed = mounted.render();
  assert.match(String(failed.error), /temporary refresh failure/);
  retry(failed);
  mounted.render();
  const waiting = mounted.render();
  assert.equal(waiting.error, failed.error);
  assert.equal(waiting.acceptanceStatus, progress.acceptanceStatus);
  assert.equal(waiting.loading, false);
  assert.notEqual(waiting.view, null);
  await settle();
  assert.equal(reads, 3);
  assert.equal(mounted.render().error, failed.error, 'Keep the saved read error during refresh');
  finish(progress);
  await settle();
  assert.equal(mounted.render().error, null);
});

test('Retry shares an in-flight read and an invalidation schedules one current follow-up', async (t) => {
  let reads = 0;
  let finish: (result: unknown) => void = () => assert.fail('first request did not start');
  const old = new Promise<unknown>((resolve) => {
    finish = resolve;
  });
  const mounted = mount(async (method) => {
    if (method === Methods.RUN_RECIPE_RUNS_FOR_RUN)
      return { recipeRuns: [], selectedRecipeRunId: null };
    assert.equal(method, Methods.TASK_PROGRESS);
    if (++reads === 1) return old;
    throw new Error('current read failure');
  });
  t.after(mounted.cleanup);
  retry(mounted.render());
  mounted.render();
  await settle();
  assert.equal(reads, 1, 'Retry must share the in-flight progress read');
  mounted.invalidateProgress();
  finish(progress);
  await settle();
  assert.equal(reads, 2, 'An invalidated response needs one follow-up read');
  assert.match(String(mounted.render().error), /current read failure/);
  assert.equal(mounted.render().commandsReady, false);
  await settle();
  assert.equal(reads, 2, 'The failed follow-up must not enter a retry loop');
});

test('a disconnected cold Retry keeps its error until a connected read starts', async (t) => {
  let reads = 0;
  let finish: (result: unknown) => void = () => assert.fail('connected read did not start');
  const pending = new Promise<unknown>((resolve) => {
    finish = resolve;
  });
  const mounted = mount(async (method) => {
    if (method === Methods.TASK_PROGRESS) {
      if (++reads === 1) throw new Error('temporary read failure');
      return pending;
    }
    assert.equal(method, Methods.RUN_RECIPE_RUNS_FOR_RUN);
    return { recipeRuns: [], selectedRecipeRunId: null };
  });
  t.after(mounted.cleanup);
  mounted.render();
  await settle();
  const failed = mounted.render();
  assert.match(String(failed.error), /temporary read failure/);
  assert.equal(failed.loading, false);
  mounted.setConnected(false);
  mounted.render();
  retry(failed);
  mounted.render();
  assert.equal(mounted.render().error, failed.error);
  assert.equal(mounted.render().loading, false);
  assert.equal(reads, 1);
  mounted.setConnected(true);
  mounted.render();
  await settle();
  const waiting = mounted.render();
  assert.equal(waiting.error, null);
  assert.equal(waiting.view, null);
  assert.equal(waiting.loading, true);
  assert.equal(reads, 2);
  finish(progress);
  await settle();
  assert.notEqual(mounted.render().view, null);
});

test('evidence stays loading after criteria arrive and a cold evidence Retry clears its error', async (t) => {
  let reads = 0;
  let rejectFirst: (error: Error) => void = () => assert.fail('evidence read did not start');
  let finish: (result: unknown) => void = () => assert.fail('retry did not start');
  const first = new Promise<unknown>((_resolve, reject) => {
    rejectFirst = reject;
  });
  const second = new Promise<unknown>((resolve) => {
    finish = resolve;
  });
  const mounted = mount(async (method) => {
    if (method === Methods.TASK_PROGRESS) return progress;
    assert.equal(method, Methods.RUN_RECIPE_RUNS_FOR_RUN);
    return ++reads === 1 ? first : second;
  });
  t.after(mounted.cleanup);
  assert.equal(mounted.render().evidenceLoading, true);
  await settle();
  const waiting = mounted.render();
  assert.equal(waiting.loading, false);
  assert.equal(waiting.evidenceLoading, true);
  assert.notEqual(waiting.view, null);
  rejectFirst(new Error('temporary evidence failure'));
  await settle();
  const failed = mounted.render();
  assert.equal(failed.error, null, 'Evidence failure must not discard the acceptance read');
  assert.match(String(failed.evidenceError), /temporary evidence failure/);
  assert.equal(failed.evidenceLoading, false);
  retry(failed);
  mounted.render();
  await settle();
  assert.equal(reads, 2);
  assert.equal(mounted.render().evidenceError, null);
  assert.equal(mounted.render().evidenceLoading, true);
  finish({ recipeRuns: [], selectedRecipeRunId: 'retained-execution' });
  await settle();
  const loaded = mounted.render();
  assert.equal(loaded.evidenceLoading, false);
  assert.equal(loaded.evidenceError, null);
  assert.equal(loaded.recipeRunId, 'retained-execution');
});

test('a failed evidence refresh preserves the retained selection until a successful Retry', async (t) => {
  let reads = 0;
  let finish: (result: unknown) => void = () => assert.fail('retry did not start');
  const pending = new Promise<unknown>((resolve) => {
    finish = resolve;
  });
  const mounted = mount(async (method) => {
    if (method === Methods.TASK_PROGRESS) return progress;
    assert.equal(method, Methods.RUN_RECIPE_RUNS_FOR_RUN);
    if (++reads === 1) return { recipeRuns: [], selectedRecipeRunId: 'retained-execution' };
    if (reads === 2) throw new Error('temporary evidence refresh failure');
    return pending;
  });
  t.after(mounted.cleanup);
  mounted.render();
  await settle();
  retry(mounted.render());
  mounted.render();
  await settle();
  const failed = mounted.render();
  assert.match(String(failed.evidenceError), /temporary evidence refresh failure/);
  assert.equal(failed.recipeRunId, 'retained-execution');
  assert.equal(failed.evidenceLoading, false);
  retry(failed);
  mounted.render();
  await settle();
  const waiting = mounted.render();
  assert.equal(
    waiting.evidenceError,
    failed.evidenceError,
    'Keep the last evidence error visible until its saved observation is replaced',
  );
  assert.equal(
    waiting.commandsReady,
    false,
    'Saved evidence cannot authorize a command during Retry',
  );
  assert.equal(waiting.recipeRunId, 'retained-execution');
  assert.equal(waiting.evidenceLoading, false);
  finish({ recipeRuns: [], selectedRecipeRunId: 'refreshed-execution' });
  await settle();
  assert.equal(mounted.render().evidenceError, null);
  assert.equal(mounted.render().recipeRunId, 'refreshed-execution');
  assert.equal(mounted.render().commandsReady, true);
});

test('retained visual action rejects evidence invalidated after render before any command', async (t) => {
  let commands = 0;
  let holdEvidence = false;
  let release: (value: unknown) => void = () => assert.fail('held read missing');
  const held = new Promise<unknown>((resolve) => {
    release = resolve;
  });
  const mounted = mount(async (method) => {
    if (method === Methods.TASK_PROGRESS) return progress;
    if (method === Methods.RUN_RECIPE_RUNS_FOR_RUN)
      return holdEvidence ? held : { recipeRuns: [], selectedRecipeRunId: null };
    commands++;
    throw new Error('No command expected');
  });
  t.after(mounted.cleanup);
  mounted.render();
  await settle();
  const ready = mounted.render();
  assert.equal(ready.commandsReady, true);
  holdEvidence = true;
  mounted.invalidateEvidence();
  // Progress shares the artifact dependency and must finish its current read first.
  await settle();
  assert.equal(typeof ready.recordVisualReview, 'function');
  await assert.rejects(
    (ready.recordVisualReview as (claim: string, verdict: string) => Promise<void>)(
      'claim',
      'confirmed',
    ),
    /current evidence/,
  );
  assert.equal(commands, 0);
  release({ recipeRuns: [], selectedRecipeRunId: null });
  await settle();
});

test('retained visual action cannot follow navigation to another run', async (t) => {
  const mounted = mount(async (method) =>
    method === Methods.TASK_PROGRESS ? progress : { recipeRuns: [], selectedRecipeRunId: null },
  );
  t.after(mounted.cleanup);
  mounted.render();
  await settle();
  const previous = mounted.render();
  mounted.render({ ...run, id: 'other-run' });
  await assert.rejects(
    (previous.recordVisualReview as (claim: string, verdict: string) => Promise<void>)(
      'claim',
      'confirmed',
    ),
    /review context changed/,
  );
});
