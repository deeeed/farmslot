import assert from 'node:assert/strict';
import test from 'node:test';

import { ReadNoticeDelay } from './read-notice-delay.js';

test('ordinary refresh cycles stay silent even when each observation is a new object', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let changes = 0;
  const notice = new ReadNoticeDelay(() => changes++);
  for (let cycle = 0; cycle < 5; cycle++) {
    notice.update({ kind: 'saved', text: 'Refreshing files…' });
    t.mock.timers.tick(400);
    notice.update({ kind: 'saved', text: 'Refreshing files…' });
    t.mock.timers.tick(500);
    assert.equal(notice.visible, undefined);
    notice.update(undefined);
    t.mock.timers.tick(200);
    assert.equal(notice.visible, undefined);
  }
  assert.equal(changes, 0);
});

test('one long refresh announces once at one second, then goes silent when current', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let changes = 0;
  const notice = new ReadNoticeDelay(() => changes++);
  notice.update({ kind: 'saved', text: 'Refreshing files…' });
  t.mock.timers.tick(999);
  assert.equal(notice.visible, undefined);
  notice.update({ kind: 'saved', text: 'Refreshing files…' });
  t.mock.timers.tick(1);
  assert.deepEqual(notice.visible, { kind: 'saved', text: 'Refreshing files…' });
  assert.equal(changes, 1);
  notice.update({ kind: 'saved', text: 'Refreshing files…' });
  t.mock.timers.tick(5000);
  assert.equal(changes, 1);
  notice.update(undefined);
  assert.equal(notice.visible, undefined);
});

test('a real error stays visible during retry and clears after success or scope reset', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const notice = new ReadNoticeDelay(() => {});
  const error = { kind: 'error' as const, text: 'Could not refresh files', detail: 'EACCES' };
  notice.update(error);
  assert.deepEqual(notice.visible, error);
  notice.update({ kind: 'saved', text: 'Refreshing files…' });
  t.mock.timers.tick(200);
  assert.deepEqual(notice.visible, error);
  notice.update(undefined);
  assert.equal(notice.visible, undefined);
  notice.update({ kind: 'saved', text: 'Refreshing files…' });
  notice.clear();
  t.mock.timers.tick(2000);
  assert.equal(notice.visible, undefined);
});
