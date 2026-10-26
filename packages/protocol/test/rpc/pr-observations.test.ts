import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  PR_STORED_OBSERVATION_ERROR,
  prForSlotObservationParams,
  prForSlotStoredData,
  prReviewCommentsObservationParams,
  type PRReviewCommentsResult,
  prReviewCommentsStoredData,
  type PRStatus,
  prStatusObservationParams,
  prStatusStoredData,
} from '../../src/index.js';

test('PR detail observation identities are closed and never name a forced check', () => {
  assert.deepEqual(prStatusObservationParams({ project: 'app', pr: 7, force: false }), {
    pr: 7,
    project: 'app',
  });
  assert.throws(() => prStatusObservationParams({ pr: 7, project: 'app', force: true }), /force/);
  assert.throws(() => prStatusObservationParams({ pr: 7 }), /project/);
  assert.throws(() => prStatusObservationParams({ pr: 0, project: 'app' }), /pull request/);
  assert.throws(() => prStatusObservationParams({ pr: 7, project: '../app' }), /project/);
  assert.throws(
    () => prStatusObservationParams({ pr: 7, project: 'app', slot: 's1' }),
    /unregistered/,
  );

  assert.deepEqual(prReviewCommentsObservationParams({ repo: 'org/app', pr: 3 }), {
    pr: 3,
    repo: 'org/app',
  });
  for (const repo of ['org', 'org/app/extra', '../app', 'org/..', 'org /app'])
    assert.throws(() => prReviewCommentsObservationParams({ pr: 3, repo }), /owner\/name/);

  assert.deepEqual(prForSlotObservationParams({ slotId: 'mini:slot-1' }), {
    slotId: 'mini:slot-1',
  });
  assert.throws(() => prForSlotObservationParams({ slotId: 'a/b' }), /slot/);
  assert.throws(() => prForSlotObservationParams(null), /object/);
});

test('PR detail persistence keeps the projected value and only the failure class', () => {
  const observation = {
    status: 'stale' as const,
    observedAt: 1_000,
    error: { code: 'UPSTREAM_UNAVAILABLE', message: 'gh: token ghp_x at /Users/me/.config/gh' },
  };
  const pr = { pr: 7, repo: 'org/app', title: 'Title' } as PRStatus;
  assert.deepEqual(prStatusStoredData({ pr, observation }), {
    pr,
    observation: {
      status: 'stale',
      observedAt: 1_000,
      error: { code: 'UPSTREAM_UNAVAILABLE', message: PR_STORED_OBSERVATION_ERROR },
    },
  });
  assert.deepEqual(prStatusStoredData({ pr }), { pr });

  const comments = {
    threads: [
      {
        id: 'T1',
        path: 'src/a.ts',
        line: 3,
        resolved: false,
        outdated: false,
        comments: [
          {
            id: 5,
            body: 'Rename',
            author: 'bot',
            createdAt: 'c',
            updatedAt: 'u',
            debug: 'not part of the contract',
          },
        ],
      },
    ],
    currentUser: 'reviewer',
    observation: { status: 'ready', observedAt: 2_000 },
    stderr: 'not part of the contract',
  } as unknown as PRReviewCommentsResult;
  assert.deepEqual(prReviewCommentsStoredData(comments), {
    threads: [
      {
        id: 'T1',
        path: 'src/a.ts',
        line: 3,
        resolved: false,
        outdated: false,
        comments: [{ id: 5, body: 'Rename', author: 'bot', createdAt: 'c', updatedAt: 'u' }],
      },
    ],
    currentUser: 'reviewer',
    observation: { status: 'ready', observedAt: 2_000 },
  });

  assert.deepEqual(
    prForSlotStoredData({ pr: null, repo: null, baseRef: 'main', checkoutPath: '/Users/me' }),
    { pr: null, repo: null, baseRef: 'main' },
  );
});
