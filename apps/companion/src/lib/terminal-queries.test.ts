import assert from 'node:assert/strict';
import test from 'node:test';

import { Terminal } from '@xterm/xterm';

import { SILENCE_TERMINAL_QUERIES_JS } from './terminal-queries';

// Every query xterm 6 answers: device attributes, status and cursor reports, mode and setting
// requests, and color queries.
const QUERIES =
  '\x1b[c\x1b[>c\x1b[5n\x1b[6n\x1b[?6n\x1b[4$p\x1b[?2004$p\x1bP$qm\x1b\\' +
  '\x1b]4;1;?\x07\x1b]10;?\x07\x1b]11;?\x07\x1b]12;?\x07';

const silence = new Function(
  'term',
  `${SILENCE_TERMINAL_QUERIES_JS}\nsilenceTerminalQueries(term);`,
) as (term: Terminal) => void;

function sentAfterWrite(term: Terminal, output: string): Promise<string[]> {
  const sent: string[] = [];
  term.onData((data) => sent.push(data));
  return new Promise((resolve) => term.write(output, () => resolve(sent)));
}

test('the terminal view leaves tmux queries unanswered and still sends typed keys', async () => {
  // Control: xterm answers a tmux attach query with what showed up in the shell.
  assert.deepEqual(await sentAfterWrite(new Terminal(), '\x1b[>c'), ['\x1b[>0;276;0c']);

  const term = new Terminal();
  silence(term);
  const sent = await sentAfterWrite(term, `${QUERIES}\x1b]10;#ffffff\x07prompt $ `);
  assert.deepEqual(sent, []);
  assert.equal(term.buffer.active.getLine(0)?.translateToString(true), 'prompt $ ');

  term.input('ls\x1b[A', true);
  assert.deepEqual(sent, ['ls\x1b[A']);
});
