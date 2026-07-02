import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DOMAIN_NAME_RE, isValidDomainName } from '../../src/index.js';

test('isValidDomainName accepts lowercase slugs with inner dots and dashes', () => {
  for (const name of ['perps', 'mobile-platform', 'a..b', 'v1.2', 'a_b', '0x']) {
    assert.equal(isValidDomainName(name), true, `expected valid: ${name}`);
  }
});

test('isValidDomainName rejects separators, sed metacharacters, and edge punctuation', () => {
  for (const name of [
    '../evil',
    'a/../b',
    'a b',
    'a|b',
    'a&b',
    'a\\b',
    'a"b',
    "a'b",
    'Blue',
    '.hidden',
    'trailing-',
    'blue\nEVIL',
    '',
    '   ',
    'a'.repeat(65),
  ]) {
    assert.equal(isValidDomainName(name), false, `expected invalid: ${JSON.stringify(name)}`);
  }
});

test('DOMAIN_NAME_RE is exported for shell/installer parity checks', () => {
  assert.equal(DOMAIN_NAME_RE.test('perps'), true);
  assert.equal(DOMAIN_NAME_RE.test('../evil'), false);
});
