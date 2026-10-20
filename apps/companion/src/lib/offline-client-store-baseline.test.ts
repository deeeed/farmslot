import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createOfflineClientStoreBaseline } from './offline-client-store-baseline';

test('baseline counts UTF-8 bytes without retaining credentials or returned data', () => {
  const meter = createOfflineClientStoreBaseline(() => assert.fail('Unexpected transport change'));
  meter.begin('reconnect');
  meter.sent({
    type: 'req',
    id: 'auth',
    method: 'auth.connect',
    params: { token: 'secret-marker' },
  });
  meter.sent({ type: 'req', id: 'list', method: 'run.list', params: { active: true } });
  const frame = { type: 'res' as const, id: 'list', ok: true, payload: { runs: ['é'] } };
  const raw = JSON.stringify(frame);
  meter.received(raw, frame);
  const [sample] = meter.snapshot();
  assert.equal(sample.responseBytes, Buffer.byteLength(raw));
  assert.equal(sample.receivedBytes, Buffer.byteLength(raw));
  assert.equal(sample.runCount, 1);
  assert(!JSON.stringify(meter.snapshot()).includes('secret-marker'));
  assert(!JSON.stringify(meter.snapshot()).includes('é'));
  sample.runCount = 99;
  assert.equal(meter.snapshot()[0].runCount, 1);
});

test('diff measurement requires the named slot and a successful reply', () => {
  const meter = createOfflineClientStoreBaseline(() => assert.fail('Unexpected transport change'));
  meter.begin('diff', { slotId: 'expected' });
  for (const [id, slotId, ok] of [
    ['wrong', 'other', true],
    ['failed', 'expected', false],
  ] as const) {
    meter.sent({ type: 'req', id, method: 'git.diff', params: { slotId } });
    const frame = { type: 'res' as const, id, ok };
    meter.received(JSON.stringify(frame), frame);
  }
  assert.deepEqual(meter.snapshot(), []);
  meter.sent({ type: 'req', id: 'right', method: 'git.diff', params: { slotId: 'expected' } });
  const response = {
    type: 'res' as const,
    id: 'right',
    ok: true,
    payload: { diff: '@@ -1 +1 @@\n-old\n+new\n' },
  };
  meter.received(JSON.stringify(response), response);
  assert.equal(meter.snapshot()[0].phase, 'diff');
  assert.equal(meter.snapshot()[0].diffCharacters, response.payload.diff.length);
});

test('a missing native startup clock cannot produce a claimed cold-start measurement', () => {
  const meter = createOfflineClientStoreBaseline(() => assert.fail('Unexpected transport change'));
  assert.equal(meter.timingSource(), 'unavailable');
  meter.sent({ type: 'req', id: 'list', method: 'run.list' });
  const response = { type: 'res' as const, id: 'list', ok: true, payload: { runs: [] } };
  meter.received(JSON.stringify(response), response);
  assert.deepEqual(meter.snapshot(), []);
});
