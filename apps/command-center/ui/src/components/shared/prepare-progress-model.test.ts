import assert from 'node:assert/strict';
import test from 'node:test';

import {
  appendPrepareOutput,
  createPrepareProgressState,
  splitPrepareOutputLines,
} from './prepare-progress-model.js';

test('splitPrepareOutputLines preserves intentional blank lines', () => {
  assert.deepEqual(splitPrepareOutputLines('a\n\nb\n'), ['a', '', 'b']);
  assert.deepEqual(splitPrepareOutputLines('a\n'), ['a']);
  assert.deepEqual(splitPrepareOutputLines('\n'), ['']);
});

test('appendPrepareOutput keeps blank lines from streamed chunks', () => {
  const state = createPrepareProgressState({ slotId: 'mm-1', requestId: 'req-1' });
  const next = appendPrepareOutput(state, 'line1\n\nline2');
  assert.deepEqual(next.lines, ['line1', '', 'line2']);
});