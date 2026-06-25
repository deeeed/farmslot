import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import type { SlotVars } from '../core/config.js';

const vars = { slotId: 'macwork-mm-2', remoteRepo: '/tmp/repo' } as SlotVars;

function cmdIncludes(cmd: string, fragment: string): boolean {
  return cmd.includes(fragment);
}

mock.module('../core/exec.js', {
  namedExports: {
    isLocal: () => true,
    execLocal: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    execOnSlot: async (_vars: SlotVars, cmd: string) => {
      if (cmdIncludes(cmd, 'has-session')) {
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (cmdIncludes(cmd, 'list-panes') && cmdIncludes(cmd, 'mm-2:1.1')) {
        return { exitCode: 0, stdout: '0', stderr: '' };
      }
      if (cmdIncludes(cmd, 'display-message') && cmdIncludes(cmd, 'mm-2:1.1')) {
        return { exitCode: 0, stdout: 'metro-8062', stderr: '' };
      }
      if (cmdIncludes(cmd, 'new-window') && cmdIncludes(cmd, 'dev')) {
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (cmdIncludes(cmd, 'list-panes') && cmdIncludes(cmd, 'mm-2:dev')) {
        return { exitCode: 0, stdout: '0', stderr: '' };
      }
      if (cmdIncludes(cmd, 'list-windows') && cmdIncludes(cmd, "list-windows -t 'mm-2'")) {
        return { exitCode: 0, stdout: '1', stderr: '' };
      }
      if (cmdIncludes(cmd, 'list-panes') && cmdIncludes(cmd, 'mm-2:self-review')) {
        return { exitCode: 1, stdout: '', stderr: 'not found' };
      }
      if (cmdIncludes(cmd, 'new-window') && cmdIncludes(cmd, 'self-review')) {
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      return { exitCode: 1, stdout: '', stderr: 'unexpected command' };
    },
  },
});

const { ensureTmuxTargetReadyForRelaunch } = await import('./worker-lifecycle.js');

test('ensureTmuxTargetReadyForRelaunch recreates role window when numeric index drifted', async () => {
  const target = await ensureTmuxTargetReadyForRelaunch(vars, 'mm-2', 'mm-2:1.1', 'dev');
  assert.equal(target, 'mm-2:dev');
});

test('ensureTmuxTargetReadyForRelaunch keeps named role window when pane is alive', async () => {
  const target = await ensureTmuxTargetReadyForRelaunch(vars, 'mm-2', 'mm-2:dev', 'dev');
  assert.equal(target, 'mm-2:dev');
});

test('ensureTmuxTargetReadyForRelaunch creates missing named window', async () => {
  const target = await ensureTmuxTargetReadyForRelaunch(vars, 'mm-2', 'mm-2:self-review', 'self-review');
  assert.equal(target, 'mm-2:self-review');
});

test('ensureTmuxTargetReadyForRelaunch resolves first window for base-index-1 hosts', async () => {
  const target = await ensureTmuxTargetReadyForRelaunch(vars, 'mm-2', 'mm-2:0', null);
  assert.equal(target, 'mm-2:1');
});