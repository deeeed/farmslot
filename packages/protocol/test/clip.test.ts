import assert from 'node:assert/strict';
import test from 'node:test';

import { resourceQuery } from '../src/client-cache/registry.js';
import { clipLinkUrl, clipTextParts } from '../src/rpc/clip.js';
import { Methods } from '../src/rpc/registry.js';

test('clip text splits into plain runs and tappable http(s) links', () => {
  assert.deepEqual(clipTextParts('PRs: https://github.com/o/r/pull/1, and http://x.test/a.'), [
    { text: 'PRs: ' },
    { text: 'https://github.com/o/r/pull/1', url: 'https://github.com/o/r/pull/1' },
    { text: ', and ' },
    { text: 'http://x.test/a', url: 'http://x.test/a' },
    { text: '.' },
  ]);
  assert.deepEqual(clipTextParts('no links here'), [{ text: 'no links here' }]);
  assert.deepEqual(clipTextParts('ftp://x.test'), [{ text: 'ftp://x.test' }]);
});

test('a link clip is exactly one http(s) URL', () => {
  assert.equal(clipLinkUrl(' https://claude.ai/code/artifact/1 ')?.host, 'claude.ai');
  assert.equal(clipLinkUrl('https://a.test b'), undefined);
  assert.equal(clipLinkUrl('javascript:alert(1)'), undefined);
  assert.equal(clipLinkUrl('see https://a.test'), undefined);
});

test('clip.list is a live read keyed to the reader', () => {
  const query = resourceQuery(Methods.CLIP_LIST, {}, 'alice');
  assert.equal(query.live, true);
  assert.deepEqual(query.dependencies, [{ family: 'clipboard', ownerId: 'alice' }]);
  assert.throws(() => resourceQuery(Methods.CLIP_LIST, {}), /authenticated reader/);
  assert.throws(() => resourceQuery(Methods.CLIP_LIST, { ownerId: 'bob' }, 'alice'));
});
