import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath, URL } from 'node:url';
import vm from 'node:vm';

import ts from 'typescript';

import { isGatewayBackgroundPauseError } from '../lib/recoverable-errors';

import type { Reread } from './useReread';

type Read = (() => Promise<string>) | null;

/** Execute the actual hook with deterministic React scheduling. */
function mount() {
  const cells: unknown[] = [];
  const effects: Array<{ deps: readonly unknown[] }> = [];
  let cell = 0;
  let effect = 0;
  let pending: Array<() => void> = [];
  const react = {
    useState(initial: unknown) {
      const index = cell++;
      if (!(index in cells)) cells[index] = initial;
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
    useCallback(callback: unknown) {
      return callback;
    },
    useEffect(callback: () => unknown, deps: readonly unknown[]) {
      const index = effect++;
      const previous = effects[index];
      if (previous && deps.every((value, at) => Object.is(value, previous.deps[at]))) return;
      pending.push(() => {
        callback();
        effects[index] = { deps };
      });
    },
  };
  const dependencies: Record<string, unknown> = {
    react,
    '../lib/recoverable-errors': { isGatewayBackgroundPauseError },
  };
  const exports: Record<string, unknown> = {};
  const source = readFileSync(fileURLToPath(new URL('./useReread.ts', import.meta.url)), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(
    compiled,
    {
      exports,
      // The test's errors and the hook's instanceof checks share one realm.
      Error,
      console: { ...console, warn: () => undefined },
      require(name: string) {
        if (!(name in dependencies)) throw new Error(`Unexpected hook dependency ${name}`);
        return dependencies[name];
      },
    },
    { timeout: 1000 },
  );
  const hook = exports.useReread;
  if (typeof hook !== 'function') throw new Error('Hook export missing');
  return (read: Read): Reread<string> => {
    cell = 0;
    effect = 0;
    pending = [];
    const result = hook(read, (reason: string, message: string) => `${reason}: ${message}`);
    for (const callback of pending) callback();
    return result as Reread<string>;
  };
}

const replies = (...outcomes: Array<string | Error>): Read => {
  const queue = [...outcomes];
  return async () => {
    const next = queue.shift();
    if (next instanceof Error) throw next;
    if (next === undefined) throw new Error('No reply queued');
    return next;
  };
};

test('a later successful read clears the error an earlier read reported', async () => {
  const render = mount();
  const read = replies(new Error('Connection closed'), 'groups');
  await render(read).refresh('initial load', true);
  assert.deepEqual(
    { value: render(read).value, error: render(read).error },
    { value: null, error: 'initial load: Connection closed' },
  );
  await render(read).refresh('connect', false);
  const after = render(read);
  assert.equal(after.error, null, 'the banner clears');
  assert.equal(after.value, 'groups');
});

test('a failed re-read keeps the value on screen; a pause stays quiet', async () => {
  const render = mount();
  const read = replies(
    'pairs',
    new Error('Connection closed'),
    new Error('Gateway paused while app is in the background'),
  );
  await render(read).refresh('initial load', true);
  await render(read).refresh('run.updated', false);
  let state = render(read);
  assert.equal(state.value, 'pairs', 'a real error does not wipe what was loaded');
  assert.equal(state.error, 'run.updated: Connection closed');
  await state.refresh('connect', false);
  state = render(read);
  assert.equal(state.value, 'pairs');
  assert.equal(state.error, 'run.updated: Connection closed', 'a pause neither reports nor clears');
  assert.equal(state.settled, true);
});

test('a new target starts fresh, no target clears, and only the latest request lands', async () => {
  const render = mount();
  const first = replies('old');
  await render(first).refresh('initial load', true);
  let release: (value: string) => void = () => undefined;
  const slow: Read = () => new Promise((resolve) => (release = resolve));
  const next = replies('new');
  const stale = render(slow).refresh('initial load', true);
  assert.equal(render(slow).value, null, 'reset drops the previous target');
  await render(next).refresh('initial load', true);
  release('late');
  await stale;
  assert.equal(render(next).value, 'new', 'a superseded reply does not land');
  render(null); // the clearing effect runs after this render
  const cleared = render(null);
  assert.deepEqual(
    { value: cleared.value, error: cleared.error, settled: cleared.settled },
    { value: null, error: null, settled: false },
  );
});
