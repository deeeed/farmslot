import assert from 'node:assert/strict';
import test from 'node:test';

import type { AgentContext } from '../contracts/index.js';

import {
  agentRoleForWindowName,
  allocateReviewerContext,
  isReviewerWindowName,
  LEGACY_SELF_REVIEW_WINDOW,
  reviewerWindowName,
  selectLatestReviewerContext,
} from './reviewer-context.js';

test('reviewerWindowName keeps model out of the tab and numbers collisions', () => {
  assert.equal(reviewerWindowName('codex'), 'rev-codex');
  assert.equal(reviewerWindowName('claude'), 'rev-claude');
  assert.equal(reviewerWindowName('Codex CLI'), 'rev-codex-cli');
  assert.equal(reviewerWindowName('codex', 1), 'rev1-codex');
  assert.equal(reviewerWindowName('codex', 2), 'rev2-codex');
  assert.ok(!reviewerWindowName('codex').includes('opus'));
});

test('isReviewerWindowName recognizes short and legacy names', () => {
  assert.equal(isReviewerWindowName('rev-codex'), true);
  assert.equal(isReviewerWindowName('rev1-claude'), true);
  assert.equal(isReviewerWindowName(LEGACY_SELF_REVIEW_WINDOW), true);
  assert.equal(isReviewerWindowName('review-fix'), true);
  assert.equal(isReviewerWindowName('review-fix-4'), true);
  assert.equal(isReviewerWindowName('review-fix-old'), false);
  assert.equal(isReviewerWindowName('bugfix'), false);
  assert.equal(isReviewerWindowName('dev'), false);
});

test('allocateReviewerContext coexists for multiple runners on one run', () => {
  const runId = 'run-a';
  const first = allocateReviewerContext({
    runId,
    runner: 'codex',
    model: 'gpt-5',
    existing: [],
  });
  assert.equal(first.windowName, 'rev-codex');
  assert.equal(first.id, 'rev-codex');
  assert.equal(first.role, 'self-review');
  assert.match(first.label, /gpt-5/);

  const second = allocateReviewerContext({
    runId,
    runner: 'claude',
    model: 'opus',
    existing: [
      {
        id: first.id,
        role: 'self-review',
        runId,
        runner: 'codex',
        target: { session: 's', window: first.windowName, target: `s:${first.windowName}` },
      },
    ],
  });
  assert.equal(second.windowName, 'rev-claude');
  assert.notEqual(second.id, first.id);

  const freshSameRunner = allocateReviewerContext({
    runId,
    runner: 'codex',
    mode: 'fresh',
    existing: [
      {
        id: first.id,
        role: 'self-review',
        runId,
        runner: 'codex',
        target: { session: 's', window: first.windowName, target: `s:${first.windowName}` },
      },
      {
        id: second.id,
        role: 'self-review',
        runId,
        runner: 'claude',
        target: { session: 's', window: second.windowName, target: `s:${second.windowName}` },
      },
    ],
  });
  assert.equal(freshSameRunner.windowName, 'rev1-codex');
});

test('allocateReviewerContext warm reuses same-runner tab and ignores other runs', () => {
  const runId = 'run-a';
  const warm = allocateReviewerContext({
    runId,
    runner: 'codex',
    mode: 'warm',
    existing: [
      {
        id: 'rev-codex',
        role: 'self-review',
        runId,
        runner: 'codex',
        target: { session: 's', window: 'rev-codex', target: 's:rev-codex' },
      },
      {
        id: 'rev-codex',
        role: 'self-review',
        runId: 'other-run',
        runner: 'codex',
        target: { session: 's', window: 'rev-codex', target: 's:rev-codex' },
      },
    ],
  });
  assert.equal(warm.windowName, 'rev-codex');
  assert.equal(warm.id, 'rev-codex');
  assert.equal(warm.runId, runId);
});

test('selectLatestReviewerContext picks newest reviewer independently of worker', () => {
  const contexts = [
    {
      id: 'fix-bug',
      role: 'fix-bug' as const,
      updatedAt: '2026-07-09T12:00:00Z',
    },
    {
      id: 'rev-codex',
      role: 'self-review' as const,
      updatedAt: '2026-07-09T12:01:00Z',
      target: { session: 's', window: 'rev-codex', target: 's:rev-codex' },
    },
    {
      id: 'rev-claude',
      role: 'self-review' as const,
      updatedAt: '2026-07-09T12:02:00Z',
      target: { session: 's', window: 'rev-claude', target: 's:rev-claude' },
    },
  ] as AgentContext[];
  assert.equal(selectLatestReviewerContext(contexts)?.id, 'rev-claude');
  assert.equal(selectLatestReviewerContext(contexts.slice(0, 1)), null);
});

test('agentRoleForWindowName maps reviewer tabs to self-review', () => {
  assert.equal(agentRoleForWindowName('rev-codex'), 'self-review');
  assert.equal(agentRoleForWindowName('rev1-claude'), 'self-review');
  assert.equal(agentRoleForWindowName(LEGACY_SELF_REVIEW_WINDOW), 'self-review');
  assert.equal(agentRoleForWindowName('bugfix'), 'fix-bug');
  assert.equal(agentRoleForWindowName('unknown'), null);
});
