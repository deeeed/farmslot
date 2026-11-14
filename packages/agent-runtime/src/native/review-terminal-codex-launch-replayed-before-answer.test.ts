import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

import { codexReplayFixture, tmuxSkip } from './review-terminal.test-support.js';

test(
  'a Codex launch replayed before its answer resumes the Folder access handshake',
  tmuxSkip,
  (context) => {
    const { marker, replay, tmux, session, entered } = codexReplayFixture(context);
    // The helper died before claiming the answer: the replay answers once and records it.
    const resumed = replay(false);
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.equal(JSON.parse(resumed.stdout).folderAccess, 'restricted');
    const saved = JSON.parse(readFileSync(marker, 'utf8'));
    assert.equal(saved.codexHandshake, 'done');
    assert.equal(saved.folderAccess, 'restricted');
    assert.match(tmux('capture-pane', '-p', '-t', session).stdout, /esc to interrupt/);
    assert.equal(existsSync(entered), true);
  },
);
