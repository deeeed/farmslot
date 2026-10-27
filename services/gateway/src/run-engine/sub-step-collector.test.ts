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

test('unverified preflight observations stay skipped in snapshots and completed records', () => {
  const c = createSubStepCollector();
  c.emit('dispatch.step', {
    name: 'preflight-code',
    detail: 'Source observation unverified',
    outcome: 'skipped',
  });
  assert.equal(c.snapshot()[0].outcome, 'skipped');
  c.emit('dispatch.step', {
    name: 'preflight-toolchain',
    detail: 'Toolchain verified',
    outcome: 'ok',
  });
  const records = c.finish();
  assert.equal(records[0].outcome, 'skipped');
  assert.equal(records[1].outcome, 'ok');
});

test('a verified retry explicitly replaces its earlier unverified outcome', () => {
  const c = createSubStepCollector();
  c.emit('dispatch.step', { name: 'preflight-code', detail: 'Timed out', outcome: 'skipped' });
  c.emit('dispatch.step', {
    name: 'preflight-code',
    detail: 'Pinned bytes verified on retry',
    outcome: 'ok',
  });
  const records = c.finish();
  assert.equal(records.length, 1);
  assert.equal(records[0].outcome, 'ok');
  assert.match(records[0].detail ?? '', /verified on retry/);
});
