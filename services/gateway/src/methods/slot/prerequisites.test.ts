import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import test from 'node:test';
import { promisify } from 'node:util';

import type { ExecResult } from '@farmslot/protocol';

import type { SlotVars } from '../../core/index.js';

import { checkProjectPrerequisites } from './prerequisites.js';

const exec = promisify(execFile);
const vars: SlotVars = {
  slotId: 'node-terminal-1',
  machine: 'node',
  host: 'localhost',
  remoteRepo: '/checkout',
  repo: '/checkout',
  session: 'terminal-1',
  resourceVars: {},
  machineEnv: { DEPENDENCY_ROOT: '/configured path' },
  platform: 'web',
  sshUser: 'example',
  osType: 'linux',
  claudePath: '',
  codexPath: '',
  opencodePath: '',
  cursorPath: '',
  grokPath: '',
  dispatchCmd: '',
  recycleCmd: '',
  slotMode: 'dispatch',
  slotEnabled: true,
  sshTarget: 'example@node',
  projectName: 'example-farm',
};

test('absent prerequisite hook keeps existing projects unchanged', async () => {
  assert.equal(
    await checkProjectPrerequisites(vars, {}, undefined, undefined, async () => {
      throw new Error('must not execute');
    }),
    null,
  );
});

test('pool environment overrides project defaults in the real check shell', async () => {
  const result = await checkProjectPrerequisites(
    vars,
    {
      command_env: { set: { DEPENDENCY_ROOT: '/wrong' } },
      hooks: {
        prerequisites:
          'test "$FARMSLOT_MACHINE" = "node" && test "$DEPENDENCY_ROOT" = "/configured path" && printf "paths configured"',
      },
    },
    undefined,
    undefined,
    async (_vars, command, options) => {
      assert.equal(typeof options === 'object' && options.selectNodeSupport, false);
      const { stdout, stderr } = await exec('bash', ['-c', command]);
      return { stdout, stderr, exitCode: 0 };
    },
  );
  assert.deepEqual(result, { name: 'prerequisites', status: 'pass', detail: 'paths configured' });
});

test('failure retains the actionable node path diagnostic', async () => {
  const result = await checkProjectPrerequisites(
    vars,
    { hooks: { prerequisites: 'check-paths' } },
    undefined,
    undefined,
    async (): Promise<ExecResult> => ({
      stdout: '',
      stderr: 'missing extension checkout on node, set TERMINAL_EXTENSION_CHECKOUT\n',
      exitCode: 1,
    }),
  );
  assert.deepEqual(result, {
    name: 'prerequisites',
    status: 'fail',
    detail: 'missing extension checkout on node, set TERMINAL_EXTENSION_CHECKOUT',
  });
});
