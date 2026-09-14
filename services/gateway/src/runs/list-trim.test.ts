import assert from 'node:assert/strict';
import test from 'node:test';

import type { Run, RunDecision } from '@farmslot/protocol';

import { RUN_LIST_PAYLOAD_VALUE_LIMIT, trimDecisionForList, trimRunForList } from './list-trim.js';

const big = 'x'.repeat(RUN_LIST_PAYLOAD_VALUE_LIMIT);

function decision(payload: Record<string, unknown>): RunDecision {
  return {
    id: 'd1',
    type: 'engine_review_posting',
    title: 't',
    description: '',
    actions: [],
    createdAt: '2026-09-14T00:00:00.000Z',
    payload: payload as unknown as RunDecision['payload'],
  } as RunDecision;
}

test('run.list keeps small decision payload values and names the large ones it drops', () => {
  const trimmed = trimDecisionForList(
    decision({
      kind: 'review',
      recommendation: 'REQUEST_CHANGES',
      reviewMd: big,
      prPackage: { draftBody: big },
    }),
  );
  assert.deepEqual(trimmed.payload, { kind: 'review', recommendation: 'REQUEST_CHANGES' });
  assert.deepEqual(trimmed.payloadTrimmed, ['reviewMd', 'prPackage']);
});

test('a decision with only small values is returned as-is, without a marker', () => {
  const small = decision({ kind: 'review', recommendation: 'COMMENT' });
  assert.equal(trimDecisionForList(small), small);
  assert.equal(trimDecisionForList(small).payloadTrimmed, undefined);
});

test('trimRunForList copies instead of mutating the stored run', () => {
  const run = {
    id: 'r1',
    decisions: [decision({ kind: 'review', reviewMd: big }), decision({ kind: 'ready' })],
  } as unknown as Run;
  const listed = trimRunForList(run);
  assert.notEqual(listed, run);
  assert.equal(
    (run.decisions[0].payload as unknown as Record<string, unknown>).reviewMd,
    big,
    'the store object keeps its payload',
  );
  assert.equal(listed.decisions[0].payloadTrimmed?.[0], 'reviewMd');
  assert.equal(listed.decisions[1], run.decisions[1], 'untouched decisions are shared');
  const noop = { id: 'r2', decisions: [decision({ kind: 'ready' })] } as unknown as Run;
  assert.equal(trimRunForList(noop), noop);
});

test('the limit is measured in UTF-8 bytes, not string length', () => {
  // 1,000 three-byte characters: 1,002 JSON characters, 3,002 JSON bytes.
  const wide = '\u4e2d'.repeat(1000);
  const trimmed = trimDecisionForList(decision({ kind: 'review', reviewMd: wide }));
  assert.deepEqual(trimmed.payloadTrimmed, ['reviewMd']);
  const narrow = 'x'.repeat(RUN_LIST_PAYLOAD_VALUE_LIMIT - 2);
  assert.equal(
    trimDecisionForList(decision({ kind: 'review', reviewMd: narrow })).payloadTrimmed,
    undefined,
  );
});
