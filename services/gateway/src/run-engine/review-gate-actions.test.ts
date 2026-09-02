import assert from 'node:assert/strict';
import test from 'node:test';

import { reviewPostingActions } from './review-gate.js';

test('review posting hides Post to PR until review markdown exists', () => {
  assert.deepEqual(reviewPostingActions(''), [
    { id: 'dismiss', label: 'Dismiss', style: 'secondary' },
  ]);
  assert.deepEqual(reviewPostingActions('  \n'), [
    { id: 'dismiss', label: 'Dismiss', style: 'secondary' },
  ]);
  assert.deepEqual(reviewPostingActions(undefined), [
    { id: 'dismiss', label: 'Dismiss', style: 'secondary' },
  ]);
  assert.deepEqual(reviewPostingActions('# Review\n\nLooks good.'), [
    { id: 'post', label: 'Post to PR', style: 'primary' },
    { id: 'dismiss', label: 'Dismiss', style: 'secondary' },
  ]);
});
