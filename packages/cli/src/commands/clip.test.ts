import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';

import { CLIP_TEXT_MAX_BYTES } from '@farmslot/protocol';

import { clipPushParams, readClipStdin } from './clip.js';

test('stdin text becomes the clip, with label and source', async () => {
  const stdin = await readClipStdin(Readable.from([Buffer.from('Slack draft\n'), 'line two\n']));
  assert.deepEqual(clipPushParams({ label: 'Slack · test' }, stdin, 'lane-3'), {
    text: 'Slack draft\nline two\n',
    label: 'Slack · test',
    source: 'lane-3',
  });
});

test('--text and --link need no stdin; a link must be one URL', () => {
  assert.deepEqual(clipPushParams({ text: 'yarn farmslot fleet' }, undefined), {
    text: 'yarn farmslot fleet',
  });
  assert.deepEqual(clipPushParams({ link: 'https://github.com/org/repo/pull/1' }, undefined), {
    text: 'https://github.com/org/repo/pull/1',
    kind: 'link',
  });
  assert.throws(() => clipPushParams({ link: 'github.com/pull/1' }, undefined), /Not an http/);
  assert.throws(
    () => clipPushParams({ link: 'https://example.com', text: 'x' }, undefined),
    /--link takes no other text/,
  );
  assert.throws(() => clipPushParams({}, undefined), /Nothing to clip/);
  assert.throws(() => clipPushParams({}, '  \n'), /Nothing to clip/);
});

test('text over the byte cap fails before anything is sent', async () => {
  const chunks = [Buffer.alloc(CLIP_TEXT_MAX_BYTES, 'a'), Buffer.from('b'), Buffer.alloc(1 << 20)];
  const stdin = await readClipStdin(Readable.from(chunks));
  // Reading stops at the first chunk past the cap instead of buffering the whole pipe.
  assert.equal(stdin.length, CLIP_TEXT_MAX_BYTES + 1);
  assert.throws(() => clipPushParams({}, stdin), /over the 65536-byte limit/);
  assert.equal(
    clipPushParams({}, 'a'.repeat(CLIP_TEXT_MAX_BYTES)).text.length,
    CLIP_TEXT_MAX_BYTES,
  );
});
