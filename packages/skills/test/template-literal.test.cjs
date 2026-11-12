'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { expandTemplate } = require('../scripts/lib.cjs');

test('cooking templates preserve replacement patterns in source text', () => {
  const text = "Synthetic $' | $& | $` | $$ | $1";
  assert.equal(
    expandTemplate('Before {{text}}\n{{TEXT}}\nAfter', { text }),
    `Before ${text}\n${text}\nAfter`,
  );
});
