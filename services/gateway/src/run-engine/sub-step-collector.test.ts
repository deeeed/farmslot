import assert from 'node:assert/strict';
import test from 'node:test';

import { createSubStepCollector } from './sub-step-collector.js';

test('getLastOutput records only script.output frames, one record per emitted line', () => {
  const c = createSubStepCollector();

  // A sibling event carrying the same {stream, data} shape must not be counted.
  c.emit('script.output', { stream: 'stdout', data: 'building app\n' });
  c.emit('other.channel', { stream: 'stdout', data: 'building app\n' });

  assert.equal(c.getLastOutput(), 'building app');
});

test('getLastOutput preserves order and drops blank lines across chunks', () => {
  const c = createSubStepCollector();
  c.emit('script.output', { stream: 'stdout', data: 'one\n\ntwo\n' });
  c.emit('script.output', { stream: 'stderr', data: 'three' });

  assert.equal(c.getLastOutput(), 'one\ntwo\nthree');
});
