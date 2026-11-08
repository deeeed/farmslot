import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import * as runtime from '@farmslot/slot-config/task-runtime';

import * as exec from '../../../node/src/commands/exec.js';
import { ExecRequests } from '../../../node/src/commands/exec-requests.js';

let login: Promise<NodeJS.ProcessEnv> = Promise.resolve({
  FIXTURE_LOGIN: 'login',
  FARMSLOT_POOL_DIR: '/wrong/pool',
  PWD: '/login/cwd',
  SHLVL: '2',
  OLDPWD: '/old/cwd',
  _: '/login/shell',
});
let calls = 0;
mock.module('../../../node/src/commands/exec.js', {
  namedExports: {
    ...exec,
    resolveExecPoolDir: () => '/daemon/pool',
    resolveLoginEnvironment: () => login,
  },
});
mock.module('@farmslot/slot-config/task-runtime', {
  namedExports: {
    ...runtime,
    runTaskRuntime: async (
      request: runtime.TaskRuntimeRequest,
      _farm: string,
      env: NodeJS.ProcessEnv,
      signal: AbortSignal,
    ) => {
      if (signal.aborted)
        return { exitCode: 130, stdout: '', stderr: 'Command cancelled before execution.' };
      calls++;
      for (const key of ['PWD', 'SHLVL', 'OLDPWD', '_']) assert.equal(env[key], undefined);
      return {
        exitCode: 0,
        stderr: '',
        stdout: JSON.stringify({ login: env.FIXTURE_LOGIN, pool: env.FARMSLOT_POOL_DIR, request }),
      };
    },
  },
});
const { executeTaskRuntime } = await import('../../../node/src/commands/task-runtime.js');
const input = {
  action: 'verify' as const,
  taskPath: '/task',
  supportDir: '/captured',
  env: { PROVIDER_ROOT: '/node/provider' },
};

test('daemon task handler retains its pool and request environment over the login shell', async () => {
  const result = await executeTaskRuntime(input, new AbortController().signal);
  assert.deepEqual(JSON.parse(result.stdout), {
    login: 'login',
    pool: '/daemon/pool',
    request: input,
  });
});

test('daemon task handler refuses malformed input before loading or executing', async () => {
  calls = 0;
  await assert.rejects(
    executeTaskRuntime({ ...input, action: 'mark' }, new AbortController().signal),
    /Invalid task runtime/,
  );
  assert.equal(calls, 0);
});

test('task cancellation during login setup is owned before library execution starts', async () => {
  const requests = new ExecRequests();
  let release!: (env: NodeJS.ProcessEnv) => void;
  login = new Promise((resolve) => {
    release = resolve;
  });
  calls = 0;
  const pending = requests.run('task', (signal) => executeTaskRuntime(input, signal));
  await Promise.resolve();
  assert.equal(requests.cancel('task'), true);
  release({});
  assert.equal((await pending).exitCode, 130);
  assert.equal(calls, 0);
  await requests.close();
});
