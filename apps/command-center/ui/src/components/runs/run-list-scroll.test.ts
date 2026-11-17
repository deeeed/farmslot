import assert from 'node:assert/strict';
import test from 'node:test';

import {
  restoreRunDetailScroll,
  savedRunDetailScroll,
  withRunDetailScroll,
} from './run-list-scroll.js';

test('reload restores the selected run after its detail renders, rather than clamping to a loading row', () => {
  const saved = withRunDetailScroll({ previous: 'kept' }, 'run-a', 923.5);
  const top = savedRunDetailScroll(saved, 'run-a');
  assert.equal(top, 923.5);
  assert.equal(Reflect.get(saved, 'previous'), 'kept');
  assert(top !== undefined);
  const viewport = { scrollTop: 0, scrollHeight: 900, clientHeight: 900 };
  assert.equal(restoreRunDetailScroll(viewport, top, false), false);
  assert.equal(viewport.scrollTop, 0);
  viewport.scrollHeight = 3100;
  assert.equal(restoreRunDetailScroll(viewport, top, true), true);
  assert.equal(viewport.scrollTop, 923.5);
});

test('another run and malformed history never reuse a saved position', () => {
  const saved = withRunDetailScroll(null, 'run-a', 923.5);
  assert.equal(savedRunDetailScroll(saved, 'run-b'), undefined);
  for (const state of [
    null,
    'old',
    {},
    { farmslotRunDetailScroll: { runId: 'run-a', top: -1 } },
    { farmslotRunDetailScroll: { runId: 'run-a', top: Infinity } },
    { farmslotRunDetailScroll: { runId: 'run-a', top: '923' } },
  ])
    assert.equal(savedRunDetailScroll(state, 'run-a'), undefined);
});

test('a shorter updated run restores the nearest available position', () => {
  const viewport = { scrollTop: 0, scrollHeight: 1500, clientHeight: 900 };
  restoreRunDetailScroll(viewport, 923.5, true);
  assert.equal(viewport.scrollTop, 600);
});
