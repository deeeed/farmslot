import assert from 'node:assert/strict';
import test from 'node:test';
import { URL } from 'node:url';

import { isGatewayBackgroundPauseError } from '../lib/recoverable-errors';

import { mountHook } from './hook-harness.fixtures';
import type { Reread, RereadOptions } from './useReread';

type Read<T> = (() => Promise<T>) | null;

function mount<T = string>(options?: RereadOptions<T>) {
  const hook = mountHook<[Read<T>, (reason: string, message: string) => string, RereadOptions<T>?]>(
    new URL('./useReread.ts', import.meta.url),
    'useReread',
    { '../lib/recoverable-errors': { isGatewayBackgroundPauseError } },
    { console: { ...console, warn: () => undefined } },
  );
  return (read: Read<T>) =>
    hook.render(read, (reason, message) => `${reason}: ${message}`, options) as Reread<T>;
}

function replies<T>(...outcomes: Array<T | Error>): Read<T> {
  const queue = [...outcomes];
  return async () => {
    if (!queue.length) throw new Error('No reply queued');
    const next = queue.shift();
    if (next instanceof Error) throw next;
    return next as T;
  };
}

const pause = new Error('Gateway paused while app is in the background');

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
  const read = replies('pairs', new Error('Connection closed'), pause);
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

test('a paused first read settles, so the screen stops waiting for it', async () => {
  const render = mount();
  const read = replies<string>(pause);
  await render(read).refresh('initial load', true);
  const state = render(read);
  assert.deepEqual(
    { value: state.value, error: state.error, settled: state.settled },
    { value: null, error: null, settled: true },
  );
});

test('a new target starts fresh unless the caller keeps a shared part of the value', async () => {
  type Groups = { list: string[]; evidence?: string };
  const render = mount<Groups>({ keepOnReset: ({ list }) => ({ list }) });
  const first = replies<Groups>({ list: ['a', 'b'], evidence: 'a evidence' });
  await render(first).refresh('initial load', true);
  const second = replies<Groups>(new Error('Connection closed'));
  const pending = render(second).refresh('initial load', true);
  let state = render(second);
  assert.deepEqual(
    { value: state.value, settled: state.settled },
    { value: { list: ['a', 'b'] }, settled: false },
    'the shared list stays while the new target loads; its evidence does not',
  );
  await pending;
  state = render(second);
  assert.deepEqual(state.value, { list: ['a', 'b'] }, 'a failed read keeps the kept list');
  assert.equal(state.error, 'initial load: Connection closed');

  const plain = mount();
  await plain(replies('old')).refresh('initial load', true);
  const fresh = replies('new');
  void plain(fresh).refresh('initial load', true);
  assert.equal(plain(fresh).value, null, 'without keepOnReset a new target starts empty');
});

test('only the latest request lands, and no target clears even an in-flight reply', async () => {
  const render = mount();
  let release: (value: string) => void = () => undefined;
  const slow: Read<string> = () => new Promise((resolve) => (release = resolve));
  const stale = render(slow).refresh('initial load', true);
  const next = replies('new');
  await render(next).refresh('initial load', true);
  release('late');
  await stale;
  assert.equal(render(next).value, 'new', 'a superseded reply does not land');

  const pending = render(slow).refresh('initial load', true);
  render(null); // the clearing effect runs after this render
  release('late again');
  await pending;
  const cleared = render(null);
  assert.deepEqual(
    { value: cleared.value, error: cleared.error, settled: cleared.settled },
    { value: null, error: null, settled: false },
  );
});
