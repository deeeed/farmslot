import assert from 'node:assert/strict';
import test from 'node:test';

import { CLIP_HISTORY_LIMIT, CLIP_TEXT_MAX_BYTES, type Principal } from '@farmslot/protocol';

import { GatewayMethodError } from '../core/method-error.js';
import { resourceRevisions } from '../resources/revisions.js';

import { clearClipsForTests, clipList, clipPush } from './clip.js';

const alice: Principal = {
  id: 'alice',
  subject: { type: 'person', displayName: 'Alice' },
  roles: [],
};
const bob: Principal = { id: 'bob', subject: { type: 'person', displayName: 'Bob' }, roles: [] };

function invalid(error: unknown): boolean {
  return error instanceof GatewayMethodError && error.code === 'INVALID_PARAMS';
}

test('keeps the newest clips per principal, newest first', (t) => {
  t.after(clearClipsForTests);
  for (let index = 0; index < CLIP_HISTORY_LIMIT + 5; index++)
    clipPush(alice, { text: `clip ${index}`, label: `label ${index}`, source: 'lane-1' });
  clipPush(bob, { text: 'bob only' });

  const { clips } = clipList(alice);
  assert.equal(clips.length, CLIP_HISTORY_LIMIT);
  assert.equal(clips[0].text, `clip ${CLIP_HISTORY_LIMIT + 4}`);
  assert.equal(clips.at(-1)!.text, 'clip 5');
  assert.equal(clips[0].label, `label ${CLIP_HISTORY_LIMIT + 4}`);
  assert.equal(clips[0].source, 'lane-1');
  assert.deepEqual(
    clipList(bob).clips.map(({ text }) => text),
    ['bob only'],
  );
});

test('a retired principal id reused at a new generation starts empty', (t) => {
  t.after(clearClipsForTests);
  clipPush(alice, { text: 'old identity' });
  assert.deepEqual(clipList({ ...alice, generation: 1 }).clips, []);
});

test('each push advances only the owner clipboard key', (t) => {
  t.after(clearClipsForTests);
  const key = { family: 'clipboard', ownerId: 'alice' } as const;
  const before = resourceRevisions.revision(key);
  const other = resourceRevisions.revision({ family: 'clipboard', ownerId: 'bob' });
  clipPush(alice, { text: 'hello' });
  assert.equal(resourceRevisions.revision(key), before + 1);
  assert.equal(resourceRevisions.revision({ family: 'clipboard', ownerId: 'bob' }), other);
});

test('rejects empty, oversized and malformed clips', (t) => {
  t.after(clearClipsForTests);
  assert.throws(() => clipPush(alice, { text: '  ' }), invalid);
  assert.throws(() => clipPush(alice, {}), invalid);
  assert.throws(() => clipPush(alice, { text: 'x'.repeat(CLIP_TEXT_MAX_BYTES + 1) }), invalid);
  // Multi-byte text is measured in bytes, not characters.
  assert.throws(() => clipPush(alice, { text: 'é'.repeat(CLIP_TEXT_MAX_BYTES / 2 + 1) }), invalid);
  assert.throws(() => clipPush(alice, { text: 'not a url', kind: 'link' }), invalid);
  assert.throws(() => clipPush(alice, { text: 'x', kind: 'file' }), invalid);
  assert.throws(() => clipPush(alice, { text: 'x', label: 'l'.repeat(200) }), invalid);
  assert.deepEqual(clipList(alice).clips, []);
  assert.equal(
    clipPush(alice, { text: 'x'.repeat(CLIP_TEXT_MAX_BYTES) }).clip.text.length,
    CLIP_TEXT_MAX_BYTES,
  );
});

test('link clips keep one trimmed URL and text passes through log redaction', (t) => {
  t.after(clearClipsForTests);
  const link = clipPush(alice, {
    text: ' https://claude.ai/code/artifact/08f032a4 ',
    kind: 'link',
    label: 'Farm board',
  }).clip;
  assert.equal(link.kind, 'link');
  assert.equal(link.text, 'https://claude.ai/code/artifact/08f032a4');
  const text = clipPush(alice, { text: 'export GH_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123' }).clip;
  assert.equal(text.kind, 'text');
  assert.equal(text.text, 'export GH_TOKEN=[REDACTED_GITHUB_TOKEN]');
});
