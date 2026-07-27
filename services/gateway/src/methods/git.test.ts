import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import type { SlotVars } from '../core/config.js';

const calls: string[][] = [];
mock.module('../core/exec.js', {
  namedExports: {
    execArgvOnSlot: async (_vars: SlotVars, argv: string[]) => {
      calls.push(argv);
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  },
});
mock.module('../core/config.js', {
  namedExports: {
    loadSlotVars: async () => ({ remoteRepo: '/repo' }) as SlotVars,
  },
});
mock.module('../fleet/state.js', {
  namedExports: {
    loadPoolConfigs: async () => [{ slots: [{ id: 'remote-slot', repo: '/repo' }] }],
  },
});

const { gitExec } = await import('./git.js');

test('gitExec transmits shell metacharacters as a literal argv element', async () => {
  const hostile = 'branch;touch /tmp/pwned`id`$(id)';
  await gitExec('remote-slot', ['show', hostile]);
  assert.deepEqual(calls.at(-1), ['git', 'show', hostile]);
});
