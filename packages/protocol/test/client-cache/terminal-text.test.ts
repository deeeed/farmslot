import assert from 'node:assert/strict';
import test from 'node:test';

import {
  stripTerminalControls,
  terminalTailLinesFromText,
} from '../../src/client-cache/terminal-text.js';

const link = (uri: string, text: string) => `\x1b]8;;${uri}\x1b\\${text}\x1b]8;;\x1b\\`;

test('a terminal hyperlink keeps its text, and the text after it', () => {
  const output = [
    `error: ${link('file:///w/a.rs', 'a.rs:3')}`,
    `note: see ${link('https://docs.example', 'docs')}`,
    'finished',
  ].join('\n');
  assert.equal(stripTerminalControls(output), 'error: a.rs:3\nnote: see docs\nfinished');
  assert.deepEqual(terminalTailLinesFromText(output, 2), ['note: see docs', 'finished']);
  // A title set with BEL, and colour, still go.
  assert.equal(stripTerminalControls('\x1b]0;title\x07\x1b[32mok\x1b[0m'), 'ok');
});
