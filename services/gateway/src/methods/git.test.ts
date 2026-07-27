import assert from 'node:assert/strict';
import test from 'node:test';

import { gitExec } from './git.js';

test('gitExec remote branch transmits shell metacharacters as one argv element', async () => {
  const payload = 'feature/foo;touch /tmp/pwned`id`$(id)';
  let transmitted: string[] | undefined;

  const result = await gitExec('remote-slot', ['show', payload], undefined, {
    resolveRepo: async () => '/repo',
    loadVars: async () =>
      ({
        host: 'remote.example',
        machine: 'remote-machine',
        remoteRepo: '/repo',
      }) as any,
    runOnSlot: async (_slotVars, argv) => {
      transmitted = argv;
      return { stdout: 'ok', stderr: '', exitCode: 0 };
    },
  });

  assert.deepEqual(transmitted, ['git', 'show', payload]);
  assert.equal(result.stdout, 'ok');
});

test('gitExec rejects a non-zero exit even when git emits no stderr', async () => {
  await assert.rejects(
    gitExec('local-slot', ['status'], undefined, {
      resolveRepo: async () => '/repo',
      loadVars: async () =>
        ({
          host: 'localhost',
          machine: 'local-machine',
          remoteRepo: '/repo',
        }) as any,
      runOnSlot: async () => ({ stdout: '', stderr: '', exitCode: 7 }),
    }),
    /git exited with code 7/,
  );
});
