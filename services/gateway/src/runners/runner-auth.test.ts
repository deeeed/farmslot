import assert from 'node:assert/strict';
import test from 'node:test';

import { getRunnerDefinition } from './registry.js';
import { assertRunnerAuthBeforeLaunch } from './runner-auth.js';
import { makeVars } from './test-fixtures.js';

for (const [payload, exitCode, passes] of [
  [{ status: 'ready', provider: 'anthropic', authType: 'oauth' }, 0, true],
  [{ status: 'invalid', provider: 'anthropic', reason: 'invalid_state' }, 1, false],
  [{ status: 'not_ready', reason: 'credentials_not_configured' }, 0, false],
] as const) {
  test(`provider auth ${payload.status} gates dispatch before worker launch`, async () => {
    let invoked = false;
    const action = assertRunnerAuthBeforeLaunch(
      makeVars(),
      'pi',
      'anthropic/claude-haiku-4-5',
      {},
      undefined,
      {
        execute: async (_vars, command) => {
          invoked = true;
          assert.match(command, /auth check --model 'anthropic\/claude-haiku-4-5' --json/);
          assert.doesNotMatch(command, /--no-refresh|--credentials/);
          return { stdout: JSON.stringify(payload), stderr: 'private-diagnostic', exitCode };
        },
      },
    );
    if (passes) await action;
    else
      await assert.rejects(action, (error: Error) => {
        assert.match(error.message, /authentication failed before dispatch/);
        assert.doesNotMatch(error.message, /private-diagnostic/);
        return true;
      });
    assert.equal(invoked, true);
  });
}

test('runners without an auth-check capability do not inherit Pi checks', async () => {
  await assertRunnerAuthBeforeLaunch(makeVars(), 'claude', 'haiku', {}, undefined, {
    definition: getRunnerDefinition('claude'),
    execute: async () => assert.fail('no Pi check'),
  });
});
