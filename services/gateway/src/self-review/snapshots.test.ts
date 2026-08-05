import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseReviewSnapshotArtifact,
  preferredRemoteReviewBaseRef,
  tmuxListSelfReviewWindowIdsSnippet,
} from './snapshots.js';

test('parseReviewSnapshotArtifact rejects a missing or invalid launch snapshot', () => {
  assert.equal(parseReviewSnapshotArtifact(''), null);
  assert.equal(
    parseReviewSnapshotArtifact(
      JSON.stringify({ source: 'local-git', capturedAt: '2026-08-03T00:00:00.000Z' }),
    ),
    null,
  );
  assert.equal(
    parseReviewSnapshotArtifact(
      JSON.stringify({
        source: 'local-git',
        capturedAt: '2026-08-03T00:00:00.000Z',
        headSha: 'deadbeef',
      }),
    )?.headSha,
    'deadbeef',
  );
});

test('tmuxListSelfReviewWindowIdsSnippet lists self-review windows by id, not ambiguous name target', () => {
  const snippet = tmuxListSelfReviewWindowIdsSnippet('mme-1');

  assert.match(snippet, /list-windows -t 'mme-1'/);
  assert.match(snippet, /window_id/);
  assert.match(snippet, /window_name/);
  assert.match(snippet, /self-review/);
  assert.doesNotMatch(snippet, /list-panes -t .*:self-review/);
  assert.doesNotMatch(snippet, /kill-window/);
});

test('preferredRemoteReviewBaseRef refreshes remote branches without rewriting explicit refs', () => {
  assert.equal(preferredRemoteReviewBaseRef('main'), 'origin/main');
  assert.equal(preferredRemoteReviewBaseRef('release/1.2'), 'origin/release/1.2');
  assert.equal(preferredRemoteReviewBaseRef('origin/main'), 'origin/main');
  assert.equal(preferredRemoteReviewBaseRef('refs/heads/main'), null);
});
