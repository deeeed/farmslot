import assert from 'node:assert/strict';
import test from 'node:test';

import { expected, probe } from './worker-source-preflight.test-support.js';

test('selected CLI package mismatch refuses and names the expected version', async () => {
  const value = await expected();
  value.cliVersion = '0.0.0-fixture';
  const result = await probe(value);
  assert.equal(result.status, 'mismatch');
  assert.match(result.detail, /CLI resolved .*expected 0.0.0-fixture/);
});

test('actual protocol and wire versions are checked through the selected CLI resolver', async () => {
  const value = await expected();
  value.wireVersion = '0.0.0-fixture';
  const result = await probe(value);
  assert.equal(result.status, 'mismatch');
  assert.match(result.detail, /node wire protocol resolved .*expected 0.0.0-fixture/);
});

test('a legacy task with no retained source binding remains explicitly unverified', async () => {
  const result = await probe(await expected());
  assert.equal(result.status, 'unverified');
  assert.equal(result.retry, false);
  assert.match(result.detail, /No retained task source receipt/);
});
