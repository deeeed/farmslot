import assert from 'node:assert/strict';
import test from 'node:test';

import { slotPrepareStatus } from './prepare-status.js';
import { createPrepareStream } from './prepare-stream.js';
import { activePrepareSessions } from './shared.js';

const noopEmit = () => {};

test('slotPrepareStatus reports not-preparing when no session is active', () => {
  activePrepareSessions.delete('slot-x');
  assert.deepEqual(slotPrepareStatus({ slotId: 'slot-x' }), { preparing: false, steps: [] });
});

test('createPrepareStream registers a session that slotPrepareStatus exposes', () => {
  const stream = createPrepareStream(noopEmit, {
    slotId: 'slot-x',
    requestId: 'req-1',
    startTime: 0,
  });
  stream.step('ssh', 'Connected');
  stream.step('profile', "Prepare profile 'full'");

  const status = slotPrepareStatus({ slotId: 'slot-x' });
  assert.equal(status.preparing, true);
  assert.equal(status.requestId, 'req-1');
  assert.deepEqual(status.steps, [
    { name: 'ssh', detail: 'Connected' },
    { name: 'profile', detail: "Prepare profile 'full'" },
  ]);
});

test('returned steps are a copy — callers cannot mutate the live session buffer', () => {
  createPrepareStream(noopEmit, { slotId: 'slot-y', requestId: 'req-2', startTime: 0 });
  const first = slotPrepareStatus({ slotId: 'slot-y' });
  first.steps.push({ name: 'injected', detail: 'nope' });
  assert.deepEqual(slotPrepareStatus({ slotId: 'slot-y' }).steps, []);
  activePrepareSessions.delete('slot-y');
});

test('complete() clears the session so a finished prepare is no longer reported', () => {
  const stream = createPrepareStream(noopEmit, {
    slotId: 'slot-z',
    requestId: 'req-3',
    startTime: 0,
  });
  stream.step('git', 'Checked out');
  assert.equal(slotPrepareStatus({ slotId: 'slot-z' }).preparing, true);
  stream.complete(0);
  assert.deepEqual(slotPrepareStatus({ slotId: 'slot-z' }), { preparing: false, steps: [] });
});
