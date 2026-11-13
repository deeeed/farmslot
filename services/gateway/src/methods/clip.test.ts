import assert from 'node:assert/strict';
import test from 'node:test';

import { CLIP_HISTORY_LIMIT, CLIP_TEXT_MAX_BYTES, type Principal } from '@farmslot/protocol';

import { GatewayMethodError } from '../core/method-error.js';
import { resourceRevisions } from '../resources/revisions.js';

import { clearClipsForTests, clipList, clipPush } from './clip.js';

const lane: Principal = {
  id: 'farm-automation',
  subject: { type: 'service', displayName: 'farm-automation' },
  roles: [],
};
const arthur: Principal = {
  id: 'arthur',
  subject: { type: 'person', displayName: 'Arthur' },
  roles: [],
};

function invalid(error: unknown): boolean {
  return error instanceof GatewayMethodError && error.code === 'INVALID_PARAMS';
}

test('keeps the newest 20 farm clips, newest first, with their source principal', (t) => {
  t.after(clearClipsForTests);
  for (let index = 0; index < CLIP_HISTORY_LIMIT + 5; index++)
    clipPush(lane, { text: `clip ${index}`, label: `label ${index}`, source: 'lane-1' });
  clipPush(arthur, { text: 'from arthur' });

  const { clips } = clipList();
  assert.equal(clips.length, CLIP_HISTORY_LIMIT);
  assert.equal(clips[0].text, 'from arthur');
  assert.equal(clips[0].principalId, 'arthur');
  assert.equal(clips[1].text, `clip ${CLIP_HISTORY_LIMIT + 4}`);
  assert.equal(clips[1].label, `label ${CLIP_HISTORY_LIMIT + 4}`);
  assert.equal(clips[1].principalId, 'farm-automation');
  assert.equal(clips[1].source, 'lane-1');
  assert.equal(clips.at(-1)!.text, 'clip 6');
});

test('each push advances the farm clipboard key', (t) => {
  t.after(clearClipsForTests);
  const key = { family: 'clipboard', scope: 'farm' } as const;
  const before = resourceRevisions.revision(key);
  clipPush(lane, { text: 'hello' });
  assert.equal(resourceRevisions.revision(key), before + 1);
});

test('rejects empty, oversized and malformed clips', (t) => {
  t.after(clearClipsForTests);
  assert.throws(() => clipPush(lane, { text: '  ' }), invalid);
  assert.throws(() => clipPush(lane, {}), invalid);
  assert.throws(() => clipPush(lane, { text: 'x'.repeat(CLIP_TEXT_MAX_BYTES + 1) }), invalid);
  // Multi-byte text is measured in bytes, not characters.
  assert.throws(() => clipPush(lane, { text: 'é'.repeat(CLIP_TEXT_MAX_BYTES / 2 + 1) }), invalid);
  assert.throws(() => clipPush(lane, { text: 'not a url', kind: 'link' }), invalid);
  assert.throws(() => clipPush(lane, { text: 'x', kind: 'file' }), invalid);
  assert.throws(() => clipPush(lane, { text: 'x', label: 'l'.repeat(200) }), invalid);
  // Fits before redaction (65,536 bytes) but its markers would store about 139 KB.
  const expanding = 'token=x '.repeat(CLIP_TEXT_MAX_BYTES / 8);
  assert.equal(Buffer.byteLength(expanding), CLIP_TEXT_MAX_BYTES);
  assert.throws(() => clipPush(lane, { text: expanding }), /after redaction/);
  assert.deepEqual(clipList().clips, []);
  assert.equal(
    clipPush(lane, { text: 'x'.repeat(CLIP_TEXT_MAX_BYTES) }).clip.text.length,
    CLIP_TEXT_MAX_BYTES,
  );
});

test('link clips keep one trimmed URL and text passes through log redaction', (t) => {
  t.after(clearClipsForTests);
  const link = clipPush(lane, {
    text: ' https://claude.ai/code/artifact/08f032a4 ',
    kind: 'link',
    label: 'Farm board',
  }).clip;
  assert.equal(link.kind, 'link');
  assert.equal(link.text, 'https://claude.ai/code/artifact/08f032a4');
  const text = clipPush(lane, { text: 'export GH_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123' }).clip;
  assert.equal(text.kind, 'text');
  assert.equal(text.text, 'export GH_TOKEN=[REDACTED_GITHUB_TOKEN]');
});
