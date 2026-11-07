import assert from 'node:assert/strict';
import test from 'node:test';

import { createTextDiff, nativeToolDiffText } from '../../src/client-cache/text-diff.js';
import type { NativeToolDiff } from '../../src/rpc/native-session.js';

test('shared text diffs retain unchanged context and exact line edits', () => {
  const text = createTextDiff('note.txt', 'note.txt', 'one\ntwo\nthree\n', 'one\nchanged\nthree\n');
  assert.match(text, / one\n-two\n\+changed\n three/);
});

test('native tool diffs support creation outside Git and reuse the same formatted body', () => {
  const diff: NativeToolDiff = { path: 'new.txt', oldText: null, newText: 'created\n' };
  const text = nativeToolDiffText(diff);
  assert.match(text, /--- \/dev\/null/);
  assert.match(text, /\+created/);
  assert.equal(nativeToolDiffText(diff), text);
});
