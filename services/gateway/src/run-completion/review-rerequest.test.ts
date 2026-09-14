import assert from 'node:assert/strict';
import test from 'node:test';

import { parseReviewPages, reviewersToRerequest } from './review-rerequest.js';

const review = (author: string, state: string, submittedAt: string) => ({
  author,
  state,
  submittedAt,
});

test('only reviewers whose latest verdict is still CHANGES_REQUESTED are re-requested', () => {
  const reviews = [
    review('alice', 'CHANGES_REQUESTED', '2026-09-10T10:00:00Z'),
    review('bob', 'CHANGES_REQUESTED', '2026-09-10T11:00:00Z'),
    review('bob', 'APPROVED', '2026-09-12T09:00:00Z'),
    review('carol', 'CHANGES_REQUESTED', '2026-09-11T08:00:00Z'),
    review('carol', 'COMMENTED', '2026-09-13T08:00:00Z'),
    review('dave', 'CHANGES_REQUESTED', '2026-08-23T16:25:19Z'),
    review('dave', 'DISMISSED', '2026-08-25T15:08:42Z'),
    review('erin', 'COMMENTED', '2026-09-14T12:00:00Z'),
    review('erin', 'CHANGES_REQUESTED', '2026-09-14T13:00:00Z'),
    review('cursor[bot]', 'CHANGES_REQUESTED', '2026-09-14T13:30:00Z'),
    review('me', 'CHANGES_REQUESTED', '2026-09-14T13:40:00Z'),
    review('frank', 'PENDING', '2026-09-14T13:50:00Z'),
  ];
  // carol's later plain comment does not clear her verdict; erin's later
  // CHANGES_REQUESTED after a comment does count.
  assert.deepEqual(reviewersToRerequest(reviews, 'me'), ['alice', 'carol', 'erin']);
  assert.deepEqual(reviewersToRerequest([], 'me'), []);
});

test('paginated review pages are flattened and app reviewers tagged as bots', () => {
  const stdout = JSON.stringify([
    [
      {
        user: { login: 'alice', type: 'User' },
        state: 'CHANGES_REQUESTED',
        submitted_at: '2026-09-10T10:00:00Z',
      },
      {
        user: { login: 'cursor', type: 'Bot' },
        state: 'COMMENTED',
        submitted_at: '2026-09-10T11:00:00Z',
      },
    ],
    [
      {
        user: { login: 'bob', type: 'User' },
        state: 'APPROVED',
        submitted_at: '2026-09-11T10:00:00Z',
      },
    ],
  ]);
  const reviews = parseReviewPages(stdout);
  assert.deepEqual(
    reviews.map((review) => review.author),
    ['alice', 'cursor[bot]', 'bob'],
  );
  assert.deepEqual(reviewersToRerequest(reviews, 'me'), ['alice']);
});

test('the latest review wins by time, not by string shape', () => {
  const reviews = [
    review('alice', 'CHANGES_REQUESTED', '2026-09-10T10:00:00+00:00'),
    review('alice', 'APPROVED', '2026-09-10T12:00:00Z'),
  ];
  assert.deepEqual(reviewersToRerequest(reviews, 'me'), []);
});
