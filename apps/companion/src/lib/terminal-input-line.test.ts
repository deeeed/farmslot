import assert from 'node:assert/strict';
import test from 'node:test';

import { inputLineDelta, TERMINAL_BACKSPACE } from './terminal-input-line';

test('the input line sends only what changed, in order', () => {
  // Typing appends; nothing already sent goes again.
  assert.equal(inputLineDelta('', 'g'), 'g');
  assert.equal(inputLineDelta('git st', 'git status'), 'atus');
  // Deleting sends one Backspace per character.
  assert.equal(inputLineDelta('git status', 'git stat'), TERMINAL_BACKSPACE.repeat(2));
  // An autocorrect or suggestion replacing a word rewrites only after the shared start.
  assert.equal(
    inputLineDelta('git chekout', 'git checkout'),
    `${TERMINAL_BACKSPACE.repeat(4)}ckout`,
  );
  // An emoji is one character to the shell.
  assert.equal(inputLineDelta('ok 👍', 'ok '), TERMINAL_BACKSPACE);
  assert.equal(inputLineDelta('same', 'same'), '');
});
