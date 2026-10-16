import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath, URL } from 'node:url';
import vm from 'node:vm';

import ts from 'typescript';

import { Events, Methods } from '@farmslot/protocol';

import type { RunAcceptanceSource } from './useRunAcceptance';

const run: RunAcceptanceSource = {
  id: 'fixture-run',
  slotId: 'fixture-slot',
  updatedAt: '2026-10-16T00:00:00Z',
};
const progress = { acceptanceCriteria: [], acceptanceStatus: { schemaVersion: 2, criteria: [] } };

/** Execute the actual hook with deterministic React scheduling and a read-only transport stub. */
function mount(request: (method: string) => Promise<unknown>) {
  const cells: unknown[] = [];
  const effects: Array<{ deps: readonly unknown[]; cleanup?: () => void }> = [];
  let cell = 0;
  let effect = 0;
  let pending: Array<() => void> = [];
  let connection: number | null = 1;
  const client = { request, subscribe: () => () => undefined, authenticatedPrincipal: null };
  const react = {
    useState(initial: unknown) {
      const index = cell++;
      if (!(index in cells)) cells[index] = typeof initial === 'function' ? initial() : initial;
      return [
        cells[index],
        (next: unknown) => {
          cells[index] = typeof next === 'function' ? next(cells[index]) : next;
        },
      ];
    },
    useRef(initial: unknown) {
      const index = cell++;
      if (!(index in cells)) cells[index] = { current: initial };
      return cells[index];
    },
    useMemo(calculate: () => unknown) {
      return calculate();
    },
    useEffect(callback: () => unknown, deps: readonly unknown[]) {
      const index = effect++;
      const previous = effects[index];
      if (
        previous &&
        deps.length === previous.deps.length &&
        deps.every((value, at) => Object.is(value, previous.deps[at]))
      )
        return;
      pending.push(() => {
        previous?.cleanup?.();
        const cleanup = callback();
        effects[index] = {
          deps,
          ...(typeof cleanup === 'function' ? { cleanup: () => cleanup() } : {}),
        };
      });
    },
  };
  const dependencies: Record<string, unknown> = {
    react,
    '@farmslot/protocol': { Methods, Events },
    '@farmslot/adapter-sdk/evidence': { createEvidenceReviewModel: () => null },
    '../lib/recoverable-errors': { isGatewayBackgroundPauseError: () => false },
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
  };
  const exports: Record<string, unknown> = {};
  const source = readFileSync(
    fileURLToPath(new URL('./useRunAcceptance.ts', import.meta.url)),
    'utf8',
  );
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(
    compiled,
    {
      exports,
      console,
      require(name: string) {
        if (!(name in dependencies)) throw new Error(`Unexpected hook dependency ${name}`);
        return dependencies[name];
      },
    },
    { timeout: 1000 },
  );
  const hook = exports.useRunAcceptance;
  assert.equal(typeof hook, 'function');
  if (typeof hook !== 'function') throw new Error('Hook export missing');
  return {
    render(input = run): Record<string, unknown> {
      cell = 0;
      effect = 0;
      pending = [];
      const result: unknown = hook(client, input);
      for (const callback of pending) callback();
      assert.ok(typeof result === 'object' && result !== null);
      if (typeof result !== 'object' || result === null) throw new Error('Invalid hook result');
      return Object.fromEntries(Object.entries(result));
    },
    setConnected(connected: boolean) {
      connection = connected ? 1 : null;
    },
    cleanup() {
      for (const entry of effects) entry.cleanup?.();
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
  mounted.render({ ...run });
  await settle();
  assert.equal(reads, 1);
  retry(failed);
  mounted.render();
  const waiting = mounted.render();
  assert.equal(waiting.error, null, 'A cold Retry must clear its old request error while loading');
  assert.equal(waiting.view, null);
  assert.equal(waiting.evidenceModel, null);
  await settle();
  assert.equal(reads, 2);
  finish(progress);
  await settle();
  assert.equal(evidenceReads, 1);
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
  assert.notEqual(waiting.view, null);
  await settle();
  assert.equal(reads, 3);
  finish(progress);
  await settle();
  assert.equal(mounted.render().error, null);
});

test('retry fences a response that began before the latest failed read', async (t) => {
  let reads = 0;
  let finish: (result: unknown) => void = () => assert.fail('first request did not start');
  const old = new Promise<unknown>((resolve) => {
    finish = resolve;
  });
  const mounted = mount(async (method) => {
    assert.equal(method, Methods.TASK_PROGRESS);
    if (++reads === 1) return old;
    throw new Error('current read failure');
  });
  t.after(mounted.cleanup);
  retry(mounted.render());
  mounted.render();
  await settle();
  assert.equal(reads, 2);
  finish(progress);
  await settle();
  assert.match(String(mounted.render().error), /current read failure/);
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
  mounted.setConnected(false);
  mounted.render();
  retry(failed);
  mounted.render();
  assert.equal(mounted.render().error, failed.error);
  assert.equal(reads, 1);
  mounted.setConnected(true);
  mounted.render();
  const waiting = mounted.render();
  assert.equal(waiting.error, null);
  assert.equal(waiting.view, null);
  assert.equal(reads, 2);
  finish(progress);
  await settle();
  assert.notEqual(mounted.render().view, null);
});
