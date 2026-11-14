import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import type { ExecResult } from '@farmslot/protocol';

import type { SlotVars } from './config.js';
import { TMUX_FIELD_SEPARATOR } from './tmux.js';

await import('../runtime/mock-pty.test-support.js');
let output = '';
mock.module('./exec.js', {
  namedExports: {
    EXEC_TIMEOUT_EXIT_CODE: 124,
    isLocal: () => true,
    slotFilesReadInProcess: () => true,
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
  output = `review-other${TMUX_FIELD_SEPARATOR}${TMUX_FIELD_SEPARATOR}%2${TMUX_FIELD_SEPARATOR}200\nreview-owned${TMUX_FIELD_SEPARATOR}${TMUX_FIELD_SEPARATOR}%1${TMUX_FIELD_SEPARATOR}100`;
  assert.deepEqual(await resolveExactTmuxWindowPane(vars, 'review-owned'), {
    paneId: '%1',
    panePid: '100',
  });
  assert.equal(await resolveExactTmuxWindowPane(vars, 'review'), null);
  output += `\nreview-owned${TMUX_FIELD_SEPARATOR}other${TMUX_FIELD_SEPARATOR}%3${TMUX_FIELD_SEPARATOR}300`;
  assert.equal(await resolveExactTmuxWindowPane(vars, 'review-owned'), null);
});
