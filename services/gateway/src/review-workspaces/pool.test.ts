import assert from 'node:assert/strict';
import test from 'node:test';

import type { PoolConfig } from '@farmslot/protocol';

import { rememberPoolFile } from '../fleet/machine-pool.js';

import { resolveReviewWorkspacePool } from './pool.js';

function reviewPool(project: string, overrides: Partial<PoolConfig> = {}): PoolConfig {
  return {
    machine: 'review-node',
    project,
    host: 'localhost',
    sshUser: 'fixture',
    platform: 'cli',
    os: 'linux',
    slots: [],
    reviewWorkspaces: { maxConcurrent: 2 },
    ...overrides,
  };
}

test('a machine with review pools for different projects resolves each project pool', () => {
  const alpha = reviewPool('alpha');
  const beta = reviewPool('beta');
  const pools = [alpha, beta];
  assert.equal(resolveReviewWorkspacePool(pools, 'review-node', 'alpha'), alpha);
  assert.equal(resolveReviewWorkspacePool(pools, 'review-node', 'beta'), beta);
});

test('slot membership authorizes a project in a mixed-project review pool', () => {
  const mixed = reviewPool('alpha', {
    slots: [
      {
        id: 'beta-slot',
        enabled: false,
        mode: 'dispatch',
        project: 'beta',
        repo: '/fixture',
        session: 'beta',
      },
    ],
  });
  assert.equal(
    resolveReviewWorkspacePool([reviewPool('other'), mixed], 'review-node', 'beta'),
    mixed,
  );
});

test('a single review pool keeps its capacity and ignores execution-only and other-machine pools', () => {
  const selected = reviewPool('alpha');
  assert.equal(resolveReviewWorkspacePool([selected], 'review-node', 'alpha'), selected);
  assert.equal(
    resolveReviewWorkspacePool(
      [
        reviewPool('alpha', { reviewWorkspaces: undefined }),
        reviewPool('alpha', { machine: 'other-node' }),
        selected,
      ],
      'review-node',
      'alpha',
    ),
    selected,
  );
  assert.equal(selected.reviewWorkspaces?.maxConcurrent, 2);
});

test('overlapping project pools fail with the project and matching pool ids', () => {
  const alpha = reviewPool('alpha');
  const mixed = reviewPool('beta', {
    slots: [
      {
        id: 'alpha-slot',
        enabled: true,
        mode: 'dispatch',
        project: 'alpha',
        repo: '/fixture',
        session: 'alpha',
      },
    ],
  });
  rememberPoolFile(alpha, 'alpha-review.json');
  rememberPoolFile(mixed, 'mixed-review.json');
  assert.throws(
    () => resolveReviewWorkspacePool([alpha, reviewPool('other'), mixed], 'review-node', 'alpha'),
    {
      code: 'REVIEW_WORKSPACE_NEEDS_CONFIGURATION',
      message:
        'Review machine review-node must resolve to exactly one pool configuration for project alpha; matching pools: alpha-review.json, mixed-review.json',
    },
  );
});

test('a project without review capacity on the selected machine names both in the error', () => {
  for (const pools of [
    [],
    [reviewPool('beta')],
    [reviewPool('alpha', { reviewWorkspaces: undefined })],
    [reviewPool('alpha', { machine: 'other-node' })],
  ]) {
    assert.throws(() => resolveReviewWorkspacePool(pools, 'review-node', 'alpha'), {
      code: 'REVIEW_WORKSPACE_NEEDS_CONFIGURATION',
      message:
        'Machine review-node has no pool with review workspace capacity configured for project alpha',
    });
  }
});
