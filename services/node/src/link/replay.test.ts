import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { NodeLinkAuthority } from '@farmslot/protocol';

import { appliedNodeLinkCursor, NodeLinkReplay } from './replay.js';

const authority: NodeLinkAuthority = {
  requester: { principalId: 'operator', generation: 1 },
  executor: { principalId: 'node', generation: 0 },
  grantId: 'grant',
  approvalId: 'approval',
  approval: 'framework',
};
const target = { nodeId: 'fixture', resourceId: 'workspace' };

test('bounded indexed replay expires explicitly and source replacement returns a snapshot', () => {
  const journal = new NodeLinkReplay('stream', target, authority, () => 'current snapshot', 1024);
  const initial = journal.cursor;
  for (let i = 0; i < 100; i++) journal.append('payload-' + i);
  assert(journal.retainedBytes <= 1024);
  assert(journal.retainedFrames < 100);
  assert.deepEqual(journal.resume(initial), {
    kind: 'reset',
    reason: 'expired',
    snapshot: 'current snapshot',
    cursor: journal.cursor,
  });
  const before = journal.cursor;
  const frame = journal.append('latest');
  assert.deepEqual(journal.resume(before), {
    kind: 'replay',
    frames: [frame],
    cursor: journal.cursor,
  });
  assert.equal(journal.resume({ ...before, incarnation: 'old' }).kind, 'reset');
  assert.throws(() => journal.resume({ ...journal.cursor, offset: 999 }), {
    code: 'INVALID_CURSOR',
  });
});

test('only contiguous applied frames advance acknowledgments; duplicates do not', () => {
  const cursor = { streamId: 'stream', incarnation: 'source', offset: 4 };
  assert.deepEqual(appliedNodeLinkCursor(cursor, { ...cursor, offset: 5 }), {
    ...cursor,
    offset: 5,
  });
  assert.equal(appliedNodeLinkCursor(cursor, { ...cursor, offset: 3 }), cursor);
  assert.throws(() => appliedNodeLinkCursor(cursor, { ...cursor, offset: 6 }), {
    code: 'STREAM_GAP',
  });
  assert.throws(() => appliedNodeLinkCursor(cursor, { ...cursor, incarnation: 'replacement' }), {
    code: 'SOURCE_REPLACED',
  });
});
