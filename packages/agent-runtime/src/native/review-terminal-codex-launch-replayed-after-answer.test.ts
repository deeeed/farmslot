import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

import { codexReplayFixture, tmuxSkip } from './review-terminal.test-support.js';

test('a Codex launch replayed after its answer never sends a second Enter', tmuxSkip, (context) => {
  const { marker, replay, entered } = codexReplayFixture(context);
  // The helper died after claiming its answer: the replay waits the screen out.
  const replayed = replay(true);
  assert.equal(replayed.status, 0, replayed.stderr);
  assert.equal(existsSync(entered), false);
  const saved = JSON.parse(readFileSync(marker, 'utf8'));
  assert.equal(saved.codexHandshake, 'done');
  assert.equal(saved.folderAccess, 'restricted');
});
