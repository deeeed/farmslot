import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { normalizeGitHeadPath, parseBranch } from './branch-watcher.js';

test('parseBranch extracts symbolic refs', () => {
  assert.equal(parseBranch('ref: refs/heads/feat/test\n'), 'feat/test');
});

test('parseBranch shortens detached HEAD shas', () => {
  assert.equal(parseBranch('0123456789abcdef\n'), '01234567');
});

test('normalizeGitHeadPath resolves standard repo HEAD paths', () => {
  assert.equal(normalizeGitHeadPath('/repo', '.git/HEAD'), path.resolve('/repo', '.git/HEAD'));
});

test('normalizeGitHeadPath preserves absolute worktree HEAD paths', () => {
  const worktreeHead = '/main/.git/worktrees/slot-1/HEAD';
  assert.equal(normalizeGitHeadPath('/repo', worktreeHead), worktreeHead);
});
