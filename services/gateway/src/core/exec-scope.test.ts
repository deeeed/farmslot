import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { makeVars } from '../runners/test-fixtures.js';

import { execOnSlot } from './exec.js';
import { withSlotCommandExecutor } from './exec-scope.js';

const vars = makeVars({ remoteRepo: tmpdir() });

test('owned execution scopes remain isolated across concurrent workspaces and restore default execution', async () => {
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const first = withSlotCommandExecutor(
    async () => {
      entered();
      await held;
      return { exitCode: 0, stdout: 'owner-a', stderr: '' };
    },
    () => execOnSlot(vars, 'first'),
  );
  await started;
  try {
    const second = await withSlotCommandExecutor(
      async (_vars, command, options) => {
        assert.equal(command, 'second');
        assert.equal(options.cwd, vars.remoteRepo);
        return { exitCode: 0, stdout: 'owner-b', stderr: '' };
      },
      () => execOnSlot(vars, 'second'),
    );
    assert.equal(second.stdout, 'owner-b');
    release();
    assert.equal((await first).stdout, 'owner-a');
  } finally {
    release();
    await first;
  }
  assert.equal((await execOnSlot(vars, 'printf default-restored')).stdout, 'default-restored');
});
