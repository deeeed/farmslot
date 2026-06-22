import assert from 'node:assert/strict';
import test from 'node:test';

import { tmuxListSelfReviewWindowIdsSnippet } from './snapshots.js';

test('tmuxListSelfReviewWindowIdsSnippet lists self-review windows by id, not ambiguous name target', () => {
  const snippet = tmuxListSelfReviewWindowIdsSnippet('mme-1');

  assert.match(snippet, /list-windows -t 'mme-1'/);
  assert.match(snippet, /window_id/);
  assert.match(snippet, /window_name/);
  assert.match(snippet, /self-review/);
  assert.doesNotMatch(snippet, /list-panes -t .*:self-review/);
  assert.doesNotMatch(snippet, /kill-window/);
});
