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

test('markdown emphasis, full-width punctuation and invisible characters stay out of a link', () => {
  assert.deepEqual(links('_https://a.com/x_ and *https://b.com/y*'), [
    'https://a.com/x',
    'https://b.com/y',
  ]);
  assert.deepEqual(links('見て https://a.com/x。次、https://b.com/y、'), [
    'https://a.com/x',
    'https://b.com/y',
  ]);
  assert.deepEqual(links('「https://a.com/x」と【https://b.com/y】'), [
    'https://a.com/x',
    'https://b.com/y',
  ]);
  // Japanese letters in that block (々, 〆) are part of a path.
  assert.deepEqual(links('https://example.com/wiki/時々 と https://example.com/〆切。'), [
    'https://example.com/wiki/時々',
    'https://example.com/〆切',
  ]);
  for (const invisible of [
    '\u00ad',
    '\u061c',
    '\u180e',
    '\u2066',
    '\u2067',
    '\u2068',
    '\u2069',
    '\u200b',
    '\u200e',
    '\u202e',
    '\u2060',
    '\ufeff',
    '\u0007',
    '\u0085',
  ]) {
    const text = `https://a.com/x${invisible}next`;
    assert.deepEqual(links(text), ['https://a.com/x'], JSON.stringify(invisible));
    assert.equal(
      textLinkParts(text)
        .map((part) => part.text)
        .join(''),
      text,
    );
  }
  // A host starting with a non-ASCII letter stays plain; its punycode form links.
  assert.deepEqual(links('https://ąbc.pl/x'), []);
  assert.deepEqual(links('https://xn--bc-oia.pl/x'), ['https://xn--bc-oia.pl/x']);
});

/** CPU milliseconds `run` takes, so a loaded machine does not make a linear parse look slow. */
const cpuMs = (run: () => void) => {
  const before = process.cpuUsage();
  run();
  const used = process.cpuUsage(before);
  return (used.user + used.system) / 1000;
};

test('long inputs parse in linear time', () => {
  const inputs = {
    closers: 'https://a.com/' + ')'.repeat(100_000),
    'closers and dots': 'https://a.com/' + ').'.repeat(50_000),
    dots: 'https://a.com/' + '.'.repeat(100_000),
    openers: 'https://a.com/' + '('.repeat(100_000),
    'no whitespace': 'https://a.com/' + 'a.(b)'.repeat(20_000),
    'scheme repeats': 'https://'.repeat(12_500),
    'no address': 'x'.repeat(50_000) + '://' + 'y'.repeat(50_000),
  };
  for (const [name, text] of Object.entries(inputs)) {
    let parts: ReturnType<typeof textLinkParts> = [];
    const ms = cpuMs(() => (parts = textLinkParts(text)));
    assert.ok(ms < 50, `${name}: ${ms.toFixed(1)} ms`);
    assert.equal(parts.map((part) => part.text).join(''), text, name);
  }
  assert.deepEqual(links(inputs.closers), ['https://a.com/']);
});

test('text without an address is one plain part', () => {
  assert.deepEqual(textLinkParts('no links here'), [{ text: 'no links here' }]);
  assert.deepEqual(textLinkParts(''), []);
});
