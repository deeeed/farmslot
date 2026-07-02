import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isValidTeamName, TEAM_NAME_RE } from '../../src/index.js';

test('isValidTeamName accepts lowercase slugs with inner dots and dashes', () => {
  for (const name of ['perps', 'mobile-platform', 'a..b', 'v1.2', 'a_b', '0x']) {
    assert.equal(isValidTeamName(name), true, `expected valid: ${name}`);
  }
});

test('isValidTeamName rejects separators, sed metacharacters, and edge punctuation', () => {
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
    '',
    '   ',
    'a'.repeat(65),
  ]) {
    assert.equal(isValidTeamName(name), false, `expected invalid: ${JSON.stringify(name)}`);
  }
});

test('TEAM_NAME_RE is exported for shell/installer parity checks', () => {
  assert.equal(TEAM_NAME_RE.test('perps'), true);
  assert.equal(TEAM_NAME_RE.test('../evil'), false);
});
