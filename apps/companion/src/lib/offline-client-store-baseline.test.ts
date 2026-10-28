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

test('a version-list reconnect is measured to its last catch-up page, logging each page with its ids, bytes and time', () => {
  const meter = createOfflineClientStoreBaseline(() => assert.fail('Unexpected transport change'));
  meter.begin('reconnect');
  assert.equal(meter.connection(), 1, 'a reconnect starts on the next socket');
  const reply = (id: string, payload: unknown) => {
    const frame = { type: 'res' as const, id, ok: true, payload };
    meter.received(JSON.stringify(frame), frame);
    return Buffer.byteLength(JSON.stringify(frame));
  };
  meter.sent({ type: 'req', id: 'versions', method: 'run.list', params: { versions: true } });
  meter.sent({ type: 'req', id: 'other', method: 'run.get', params: { runId: 'a' } });
  assert.equal(meter.pendingRunLists(), 1, 'only run.list reads count');
  reply('versions', {
    runs: [],
    versions: [
      { id: 'a', version: '1' },
      { id: 'b', version: '2' },
    ],
  });
  meter.sent({ type: 'req', id: 'page', method: 'run.list', params: { ids: ['a', 'b'] } });
  assert.equal(meter.pendingRunLists(), 1, 'the page is still pending');
  assert.equal(meter.merged({ status: 'ready', observedAt: Date.now() }), undefined);
  const pageBytes = reply('page', {
    runs: [{ id: 'a' }, { id: 'b' }],
    versions: [],
    totalCount: 2,
  });
  assert.equal(meter.pendingRunLists(), 0);
  const [versions, page] = meter.runListFrames();
  assert.equal(versions.kind, 'versions');
  assert.equal(versions.versions, 2);
  assert.equal(page.kind, 'ids');
  assert.deepEqual(page.requestedIds, ['a', 'b']);
  assert.equal(page.rows, 2);
  assert.equal(page.responseBytes, pageBytes);
  assert.equal(page.connection, 1);
  assert(page.requestMs >= 0 && page.at > 0);
  // The measurement ends at the last page, not at the small version reply.
  const samples = meter.snapshot();
  assert.deepEqual(
    samples.map((sample) => sample.runListKind),
    ['versions', 'ids'],
  );
  assert.equal(
    samples.at(-1)?.receivedBytes,
    samples.reduce((sum, s) => sum + s.responseBytes, 0),
  );

  const now = Date.now();
  assert.equal(meter.merged({ status: 'stale', observedAt: now }), undefined, 'not merged yet');
  assert.equal(
    meter.merged({ status: 'ready', observedAt: now - 60_000 }),
    undefined,
    'a run list read before the reconnect',
  );
  const merged = meter.merged({ status: 'ready', observedAt: now });
  assert.equal(merged?.runListKind, 'ids');
  assert.equal(merged?.runListReplies, 2);
  assert.equal(merged?.receivedBytes, samples.at(-1)?.receivedBytes);

  // A dropped socket's unanswered reads never stay pending.
  meter.sent({ type: 'req', id: 'lost', method: 'run.list', params: { ids: ['c'] } });
  meter.begin('reconnect');
  assert.equal(meter.pendingRunLists(), 0);
  assert.equal(meter.connection(), 2);
  assert.equal(meter.runListFrames().length, 2, 'the frame log outlives a phase change');
});
