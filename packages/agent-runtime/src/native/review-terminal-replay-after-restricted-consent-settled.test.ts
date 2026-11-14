import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

import { codexReplayFixture, tmuxSkip } from './review-terminal.test-support.js';

test(
  'a replay after restricted consent settled retains the owned answer without another key',
  tmuxSkip,
  (context) => {
    const { marker, replay, entered } = codexReplayFixture(context);
    const replayed = replay(true, true);
    assert.equal(replayed.status, 0, replayed.stderr);
    assert.equal(existsSync(entered), false);
    const saved = JSON.parse(readFileSync(marker, 'utf8'));
    assert.equal(saved.codexHandshake, 'done');
    assert.equal(saved.folderAccess, 'restricted');
  },
);
