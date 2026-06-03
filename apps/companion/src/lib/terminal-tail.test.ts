import assert from 'node:assert/strict';
import test from 'node:test';

import {
  appendTerminalTailText,
  stripTerminalControls,
  terminalTailLinesFromText,
  trimTrailingTerminalBlankLines,
} from './terminal-tail';
test('terminalTailLinesFromText keeps the latest sanitized terminal lines', () => {
  const raw = ['\x1b[32mfirst\x1b[0m', 'second', 'third', '\x1b]52;c;SGVsbG8=\x07fourth'].join(
    '\n',
  );

  assert.deepEqual(terminalTailLinesFromText(raw, 2), ['third', 'fourth']);
});
test('terminalTailLinesFromText treats carriage-return redraws as tail lines', () => {
  assert.deepEqual(terminalTailLinesFromText('prompt one\rprompt two', 10), [
    'prompt one',
    'prompt two',
  ]);
});
test('appendTerminalTailText caps retained terminal context', () => {
  assert.equal(appendTerminalTailText('abcdef', 'ghij', 5), 'fghij');
});
test('stripTerminalControls removes ANSI and control bytes while preserving text', () => {
  assert.equal(stripTerminalControls('\x1b[31merr\x1b[0m\tok\x07'), 'err\tok');
});
test('trimTrailingTerminalBlankLines preserves prompt lines before blank snapshot padding', () => {
  assert.deepEqual(trimTrailingTerminalBlankLines(['', 'prompt', '', '', '']), ['', 'prompt']);
  assert.deepEqual(trimTrailingTerminalBlankLines(['', '']), ['']);
});
