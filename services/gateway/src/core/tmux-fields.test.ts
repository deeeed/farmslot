import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { splitTmuxFields, TMUX_FIELD_SEPARATOR, tmuxFieldFormat } from './tmux-fields.js';

test('the snippets that cannot import the separator still spell it the same way', () => {
  // runtime/tmux-session-control.ts builds `node -e` scripts that run in their own
  // process, so they repeat the literal. A drift there would split rows on a token
  // tmux never printed, which is the defect this contract exists to prevent.
  const snippets = readFileSync(
    new URL('../runtime/tmux-session-control.ts', import.meta.url),
    'utf8',
  );
  const literals = snippets.match(/'<<[A-Z_]+>>'/g) ?? [];
  assert.ok(literals.length >= 2, 'expected the snippet separator literals to be found');
  for (const literal of literals) assert.equal(literal, `'${TMUX_FIELD_SEPARATOR}'`);
});

test('the separator cannot be produced by a tmux name, path or command', () => {
  // tmux rejects '.' and ':' in session names and nothing else is excluded, so
  // the guarantee has to come from the token: a multi-character printable
  // sequence no shell, path or runner writes by itself.
  assert.match(TMUX_FIELD_SEPARATOR, /^<<[A-Z_]+>>$/);
  assert.ok(TMUX_FIELD_SEPARATOR.length > 1);
  // A control character would be escaped by tmux 3.4 in -F output, which is the
  // defect this contract exists to prevent.
  assert.doesNotMatch(TMUX_FIELD_SEPARATOR, /[\x00-\x1f]/);
});

test('a format and its parser round-trip every field', () => {
  const fields = ['fs-1', '0', 'dev', '%0', '1890'];
  assert.equal(tmuxFieldFormat(...fields), fields.join(TMUX_FIELD_SEPARATOR));
  assert.deepEqual(splitTmuxFields(tmuxFieldFormat(...fields), 5), fields);
});

test('a row with too few fields is returned short so the caller can reject it', () => {
  // The caller decides: reading a short row loosely would bind a run to the
  // wrong pane, so the parser reports the count rather than padding it.
  assert.deepEqual(splitTmuxFields('fs-1', 5), ['fs-1']);
  assert.deepEqual(splitTmuxFields(['a', 'b'].join(TMUX_FIELD_SEPARATOR), 5), ['a', 'b']);
});

test('a separator inside the last field keeps that value whole', () => {
  // Only the last field can hold free-form text (a path or a pane command), so
  // the remainder is rejoined instead of becoming extra fields.
  const cwd = `/repo/odd${TMUX_FIELD_SEPARATOR}name`;
  assert.deepEqual(splitTmuxFields(tmuxFieldFormat('fs-1', '%0', cwd), 3), ['fs-1', '%0', cwd]);
});
