import assert from 'node:assert/strict';
import test from 'node:test';

import { resourceQuery } from '../src/client-cache/registry.js';
import { textLinkParts } from '../src/client-cache/text-links.js';
import { clipLinkUrl } from '../src/rpc/clip.js';
import { Methods } from '../src/rpc/registry.js';

test('a link clip is exactly one http(s) address, balanced brackets included', () => {
  assert.equal(
    clipLinkUrl(' https://en.wikipedia.org/wiki/Clipboard_(computing) ')?.pathname,
    '/wiki/Clipboard_(computing)',
  );
  assert.equal(clipLinkUrl(' https://claude.ai/code/artifact/1 ')?.host, 'claude.ai');
  assert.equal(clipLinkUrl('https://a.test b'), undefined);
  assert.equal(clipLinkUrl('see https://a.test'), undefined);
  // Trailing punctuation is not part of an address, so this is not one link.
  assert.equal(clipLinkUrl('https://a.test.'), undefined);
  assert.equal(clipLinkUrl('javascript:alert(1)'), undefined);
  assert.equal(clipLinkUrl('file:///etc/hosts'), undefined);
  assert.equal(clipLinkUrl('farmslot://pair?x=1'), undefined);
});

test('links inside clip text keep balanced brackets and drop sentence punctuation', () => {
  assert.deepEqual(textLinkParts('See https://en.wikipedia.org/wiki/Clipboard_(computing).'), [
    { text: 'See ' },
    {
      text: 'https://en.wikipedia.org/wiki/Clipboard_(computing)',
      href: 'https://en.wikipedia.org/wiki/Clipboard_(computing)',
    },
    { text: '.' },
  ]);
});

test('clip.list is a live read of the farm clipboard key', () => {
  const query = resourceQuery(Methods.CLIP_LIST, {});
  assert.equal(query.live, true);
  assert.deepEqual(query.dependencies, [{ family: 'clipboard', scope: 'farm' }]);
  assert.throws(() => resourceQuery(Methods.CLIP_LIST, { ownerId: 'bob' }));
});
