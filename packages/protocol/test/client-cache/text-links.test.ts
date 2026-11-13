import assert from 'node:assert/strict';
import test from 'node:test';

import { textLinkParts } from '../../src/client-cache/text-links.js';

const links = (text: string) =>
  textLinkParts(text)
    .filter((part) => part.href)
    .map((part) => part.href);

test('http and https addresses become links, and the parts join back to the text', () => {
  const text = 'PR at https://github.com/o/r/pull/1 and docs http://example.com/a?b=1#c';
  const parts = textLinkParts(text);
  assert.deepEqual(parts, [
    { text: 'PR at ' },
    { text: 'https://github.com/o/r/pull/1', href: 'https://github.com/o/r/pull/1' },
    { text: ' and docs ' },
    { text: 'http://example.com/a?b=1#c', href: 'http://example.com/a?b=1#c' },
  ]);
  assert.equal(parts.map((part) => part.text).join(''), text);
  assert.deepEqual(links('HTTPS://EXAMPLE.COM/x'), ['HTTPS://EXAMPLE.COM/x']);
  assert.deepEqual(links('ipv6 http://[::1]:7801/a'), ['http://[::1]:7801/a']);
});

test('every other scheme stays plain text', () => {
  for (const text of [
    'javascript:alert(1)',
    'file:///etc/passwd',
    'metamask://open',
    'farmslot://run/1',
    'ftp://example.com',
    'data:text/html,<b>x</b>',
    'xhttps://example.com',
    'https://',
    'https:// spaced',
    'https://.',
  ])
    assert.deepEqual(textLinkParts(text), [{ text }], text);
});

test('punctuation after an address is not part of it', () => {
  assert.deepEqual(links('See https://example.com/a.'), ['https://example.com/a']);
  assert.deepEqual(links('one https://a.com/x, two https://b.com/y;'), [
    'https://a.com/x',
    'https://b.com/y',
  ]);
  assert.deepEqual(links('done? https://a.com/x?! yes'), ['https://a.com/x']);
  assert.deepEqual(links("it's 'https://a.com/x'"), ['https://a.com/x']);
  assert.deepEqual(links('(see https://a.com/x)'), ['https://a.com/x']);
  assert.deepEqual(links('[link](https://a.com/x)'), ['https://a.com/x']);
  assert.deepEqual(links('"https://a.com/x"'), ['https://a.com/x']);
  assert.deepEqual(links('<https://a.com/x>'), ['https://a.com/x']);
  assert.deepEqual(links('`https://a.com/x`'), ['https://a.com/x']);
  // A closing bracket that closes one inside the address stays.
  assert.deepEqual(links('https://en.wikipedia.org/wiki/Lit_(software).'), [
    'https://en.wikipedia.org/wiki/Lit_(software)',
  ]);
  const text = 'end https://a.com/x.\nnext';
  assert.equal(
    textLinkParts(text)
      .map((part) => part.text)
      .join(''),
    text,
  );
});

test('text without an address is one plain part', () => {
  assert.deepEqual(textLinkParts('no links here'), [{ text: 'no links here' }]);
  assert.deepEqual(textLinkParts(''), []);
});
