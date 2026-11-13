import assert from 'node:assert/strict';
import test from 'node:test';

import { literalReplacement } from '../../scripts/literal-replacement.mjs';

test('literal replacements preserve dollar patterns for string and regex searches', () => {
  for (const value of ["$'", '$&', '$`', '$$', '$1', '$<name>', 'plain', '']) {
    assert.equal(
      'before {{TEXT}} after'.replace('{{TEXT}}', literalReplacement(value)),
      `before ${value} after`,
    );
    assert.equal(
      'a {{TEXT}} b {{TEXT}} c'.replaceAll('{{TEXT}}', literalReplacement(value)),
      `a ${value} b ${value} c`,
    );
    assert.equal(
      'before <TEXT> after'.replace(/<(?<name>TEXT)>/, literalReplacement(value)),
      `before ${value} after`,
    );
  }
});
