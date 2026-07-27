import assert from 'node:assert/strict';
import test from 'node:test';

import { labelWithRef } from './item-ref.js';

test('the ref is shown alongside the title, not only when the title is missing', () => {
  // The regression: every surface rendered the ref as a fallback, so it vanished
  // exactly when the item was well-formed and there was no way to tell which node
  // a given MANUAL-000055 referred to.
  assert.equal(
    labelWithRef('Display item IDs consistently', 'MANUAL-000052'),
    'MANUAL-000052 · Display item IDs consistently',
  );
});

test('a missing title falls back to the ref alone', () => {
  assert.equal(labelWithRef(undefined, 'MANUAL-000052'), 'MANUAL-000052');
  assert.equal(labelWithRef('   ', 'MANUAL-000052'), 'MANUAL-000052');
});

test('a missing ref leaves the title untouched', () => {
  assert.equal(labelWithRef('Some title', undefined), 'Some title');
  assert.equal(labelWithRef('Some title', '  '), 'Some title');
});

test('a title that already equals the ref is not duplicated', () => {
  assert.equal(labelWithRef('MANUAL-000052', 'MANUAL-000052'), 'MANUAL-000052');
});

test('non-manual refs work the same way', () => {
  assert.equal(labelWithRef('Fix the thing', 'TAT-1234'), 'TAT-1234 · Fix the thing');
  assert.equal(labelWithRef('Fix', 'deeeed/farmslot#392'), 'deeeed/farmslot#392 · Fix');
});
