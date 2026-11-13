import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import '../runtime/mock-pty.test-support.js';

import { withSlotCommandExecutor } from '../core/exec-scope.js';
import { makeVars } from '../runners/test-fixtures.js';

const config = await import('../core/config.js');
mock.module('../core/config.js', {
  namedExports: {
    ...config,
    loadProjectVars: async () => ({
      projectJson: { command_env: { set: { FARMSLOT_GIT_PUSH_TIMEOUT_MS: '2500' } } },
    }),
  },
});
const scripts = await import('../tasks/agent-runtime-script.js');
mock.module('../tasks/agent-runtime-script.js', {
  namedExports: { ...scripts, agentRuntimeScriptForSlot: async () => '/fixture/branch-update.mjs' },
});
const { runtimeOperation } = await import('./branch-maintenance.js');

test('branch maintenance uses the hook budget only for push and explains timeout', async () => {
  const vars = makeVars({ projectName: 'fixture' });
  const phases = ['push', 'verify', 'execute'];
  const budgets: (number | undefined)[] = [];
  for (const phase of phases) {
    await withSlotCommandExecutor(
      async (_vars, command, options) => {
        budgets.push(options.timeout);
        assert.match(command, /ServerAliveInterval=20/);
        assert.match(command, /branch-update.mjs/);
        return { exitCode: 0, stdout: '{"ok":true}', stderr: '' };
      },
      async () => assert.deepEqual(await runtimeOperation(vars, phase, {}), { ok: true }),
    );
  }
  assert.deepEqual(budgets, [2500, 60_000, 60_000]);
  await withSlotCommandExecutor(
    async () => ({ exitCode: 124, stdout: '', stderr: '' }),
    () =>
      assert.rejects(
        runtimeOperation(vars, 'push', {}),
        /git push timed out after 2500 ms.*pre-push hook budget/,
      ),
  );
});
