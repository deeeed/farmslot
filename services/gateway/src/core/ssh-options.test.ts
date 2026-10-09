import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  RSYNC_SSH_SHELL_OPTION,
  SSH_CONNECT_OPTIONS,
  SSH_CONNECT_SHELL_OPTIONS,
  SSH_INTERACTIVE_CONNECT_OPTIONS,
  SSH_INTERACTIVE_CONNECT_SHELL_OPTIONS,
} from './ssh-options.js';

/** The words bash makes of a shell string. */
function bashWords(shell: string): string[] {
  const result = spawnSync('bash', ['-c', `printf '%s\\0' ${shell}`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.split('\0').slice(0, -1);
}

test('the ssh connect options bound the connect to 10 s and never prompt', () => {
  assert.deepEqual(SSH_CONNECT_OPTIONS, ['-o', 'ConnectTimeout=10', '-o', 'BatchMode=yes']);
  assert.equal(SSH_CONNECT_SHELL_OPTIONS, '-o ConnectTimeout=10 -o BatchMode=yes');
  assert.deepEqual(bashWords(SSH_CONNECT_SHELL_OPTIONS), SSH_CONNECT_OPTIONS);
});

test('an interactive session gets the connect timeout without BatchMode', () => {
  assert.deepEqual(SSH_INTERACTIVE_CONNECT_OPTIONS, ['-o', 'ConnectTimeout=10']);
  assert.equal(SSH_INTERACTIVE_CONNECT_SHELL_OPTIONS, '-o ConnectTimeout=10');
  assert.deepEqual(
    bashWords(SSH_INTERACTIVE_CONNECT_SHELL_OPTIONS),
    SSH_INTERACTIVE_CONNECT_OPTIONS,
  );
});

test('rsync gets the same options as one -e remote shell word', () => {
  assert.equal(RSYNC_SSH_SHELL_OPTION, "-e 'ssh -o ConnectTimeout=10 -o BatchMode=yes'");
  assert.deepEqual(bashWords(RSYNC_SSH_SHELL_OPTION), [
    '-e',
    'ssh -o ConnectTimeout=10 -o BatchMode=yes',
  ]);
});
