import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { RepeatReviewContext, Run } from '@farmslot/protocol';

import { configureWorkspaceContinuity } from './continuity.js';

const prior = {
  id: 'prior',
  status: 'done',
  transport: 'tmux',
  createdByPrincipalId: 'owner',
  nativeOwnerPrincipalId: 'owner',
  reviewWorkspace: { machine: 'machine' },
  agentContexts: [{ id: 'review', runner: 'cursor', model: 'model', runnerSessionId: 'chat' }],
} as Run;
const current = {
  reviewScope: 'incremental',
  transport: 'tmux',
  createdByPrincipalId: 'owner',
  nativeOwnerPrincipalId: 'owner',
  reviewWorkspaceTarget: { machine: 'machine' },
  metrics: { runner: 'cursor', model: 'model' },
} as Run;
const context = () => ({ priorReviewedHeadSha: 'a'.repeat(40) }) as RepeatReviewContext;

test('same owner, machine and reviewer carries its exact chat into an incremental round', () => {
  const result = context();
  configureWorkspaceContinuity(current, prior, result);
  assert.equal(result.reviewScope, 'incremental');
  assert.equal(result.session?.continuity, 'resumed');
  assert.equal(result.session?.priorSessionId, 'chat');
});

test('identity changes and active predecessors reuse findings without borrowing a chat', () => {
  for (const other of [
    { ...prior, nativeOwnerPrincipalId: 'other' },
    { ...prior, createdByPrincipalId: 'other' },
    { ...prior, status: 'monitoring' },
    { ...prior, reviewWorkspace: { machine: 'elsewhere' } },
    { ...prior, agentContexts: [] },
    { ...prior, agentContexts: [{ ...prior.agentContexts![0], model: 'other' }] },
  ]) {
    const result = context();
    configureWorkspaceContinuity(current, other as Run, result);
    assert.equal(result.session?.continuity, 'fallback-fresh');
    assert.equal(result.session?.priorSessionId, undefined);
    assert.equal(result.reviewScope, 'incremental');
  }
});

test('a requested full review does not resume the previous chat', () => {
  const result = context();
  configureWorkspaceContinuity({ ...current, reviewScope: 'full' }, prior, result);
  assert.equal(result.reviewScope, 'full');
  assert.equal(result.sessionIntent, 'reset');
  assert.equal(result.session?.continuity, 'fresh');
});
