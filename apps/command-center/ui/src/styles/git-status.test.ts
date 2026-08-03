import assert from 'node:assert/strict';
import test from 'node:test';

import { gitStateChips, gitStatusColor } from './git-status.js';

test('gitStateChips labels every state a file can be in', () => {
  const chips = gitStateChips({
    committed: true,
    worktreeEntries: [
      { status: 'M', staged: true },
      { status: 'M', staged: false },
    ],
  });
  assert.deepEqual(
    chips.map((chip) => chip.label),
    ['C', 'S', 'M'],
  );
});

test('gitStateChips marks untracked files and omits absent states', () => {
  assert.deepEqual(
    gitStateChips({
      committed: false,
      worktreeEntries: [{ status: '?', staged: false }],
    }).map((chip) => chip.label),
    ['U'],
  );
  assert.deepEqual(
    gitStateChips({ committed: true, worktreeEntries: [] }).map((chip) => chip.label),
    ['C'],
  );
  assert.deepEqual(gitStateChips({ committed: undefined, worktreeEntries: [] }), []);
});

test('gitStatusColor pins the shared palette exactly', () => {
  assert.equal(gitStatusColor('M'), '#6366f1');
  assert.equal(gitStatusColor('A'), '#00ff88');
  assert.equal(gitStatusColor('D'), '#ff4444');
  assert.equal(gitStatusColor('R'), '#ffcc00');
  assert.equal(gitStatusColor('?'), '#00ff88');
});
