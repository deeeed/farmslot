import assert from 'node:assert/strict';
import test from 'node:test';

import { litBindings, litText } from '../testing/lit-text.js';

import { linkedText } from './linked-text.js';

test('user text keeps its words and links only its http(s) addresses, in a new tab', () => {
  const text = 'see https://example.com/a, not javascript:alert(1) or file:///etc <b>x</b>';
  const rendered = linkedText(text);
  assert.deepEqual(litBindings(rendered, 'href="'), ['https://example.com/a']);
  assert.equal(
    litText(rendered),
    'see <a href="https://example.com/a" target="_blank" rel="noopener noreferrer">' +
      'https://example.com/a</a>, not javascript:alert(1) or file:///etc <b>x</b>',
  );
  // The rest is a text value, which Lit escapes: the raw tag never becomes markup.
  assert.equal(rendered.at(-1), ', not javascript:alert(1) or file:///etc <b>x</b>');
});
