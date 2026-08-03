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

test('gitStatusColor covers every status with a stable palette', () => {
  for (const status of ['M', 'A', 'D', 'R', '?'] as const) {
    assert.match(gitStatusColor(status), /^#[0-9a-f]{6}$/);
  }
});
