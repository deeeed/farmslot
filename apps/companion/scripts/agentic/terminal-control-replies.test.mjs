import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { terminalControlReplies, workerInstructionAttempts } from './terminal-control-replies.mjs';

const input = (text) => ({
  method: 'terminal.worker.input',
  dataSha256: createHash('sha256').update(text).digest('hex'),
});
test('only complete, exact terminal capability and theme answers are protocol replies', () => {
  assert.equal(
    workerInstructionAttempts({ mutations: terminalControlReplies.map(input) }).length,
    0,
  );
  for (const text of [
    'Report current status.\r',
    terminalControlReplies[0] + 'Report current status.\r',
    terminalControlReplies[0] + '\n',
    '\u001b[31mreal instruction',
  ]) {
    assert.equal(workerInstructionAttempts({ mutations: [input(text)] }).length, 1);
  }
  assert.equal(
    workerInstructionAttempts({
      mutations: [
        { method: 'copilot.start', dataSha256: input(terminalControlReplies[0]).dataSha256 },
      ],
    }).length,
    1,
  );
});
