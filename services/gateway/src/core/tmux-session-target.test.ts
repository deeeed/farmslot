import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import type { ExecResult } from '@farmslot/protocol';

import type { SlotVars } from './config.js';

await import('../runtime/mock-pty.test-support.js');
let output = '';
mock.module('./exec.js', {
  namedExports: {
    EXEC_TIMEOUT_EXIT_CODE: 124,
    isLocal: () => true,
    execLocal: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    execArgvOnSlot: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    execFileArgv: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    execOnSlot: async (): Promise<ExecResult> => ({ exitCode: 0, stdout: output, stderr: '' }),
  },
});
const { resolveExactTmuxWindowPane } = await import('./tmux.js');
const { makeVars } = await import('../runners/test-fixtures.js');
const vars: SlotVars = makeVars();

test('a slot-free reviewer session resolves its single pane without prefix matching', async () => {
  output = 'review-other\t\t%2\t200\nreview-owned\t\t%1\t100';
  assert.deepEqual(await resolveExactTmuxWindowPane(vars, 'review-owned'), {
    paneId: '%1',
    panePid: '100',
  });
  assert.equal(await resolveExactTmuxWindowPane(vars, 'review'), null);
  output += '\nreview-owned\tother\t%3\t300';
  assert.equal(await resolveExactTmuxWindowPane(vars, 'review-owned'), null);
});
