import assert from 'node:assert/strict';
import test from 'node:test';

import { parse } from 'shell-quote';

import { buildPiLaunch } from './launch-command.js';
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
      undefined,
      {
        execute: async (_vars, command) => {
          invoked = true;
          assert.match(command, /pi-farmslot-providers\.mjs.*'anthropic\/claude-haiku-4-5'/);
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
  await assertRunnerAuthBeforeLaunch(makeVars(), 'claude', 'haiku', {}, undefined, undefined, {
    definition: getRunnerDefinition('claude'),
    execute: async () => assert.fail('no Pi check'),
  });
});

for (const [model, expected] of [
  [null, 'xai/grok-4.6'],
  ['unknown', 'xai/grok-4.6'],
  ['grok-4.6', 'xai/grok-4.6'],
  ['anthropic/claude-opus-5-5', 'anthropic/claude-opus-5-5'],
] as const) {
  test(`auth and launch select the same provider for ${model}`, () => {
    const vars = makeVars();
    const auth = getRunnerDefinition('pi').authCheck!(vars, model);
    const launch = buildPiLaunch({ binary: 'pi', model, repo: vars.remoteRepo });
    assert.ok(auth.endsWith(`'${expected}'`));
    const argv = parse(launch).filter((part): part is string => typeof part === 'string');
    assert.equal(argv[argv.indexOf('--model') + 1], expected);
  });
}

test('auth preflight uses the selected run domain profile', async () => {
  await assertRunnerAuthBeforeLaunch(
    makeVars({ domain: 'terminal' }),
    'pi',
    'anthropic/claude-haiku-4-5',
    {
      command_env: {
        domains: {
          terminal: { set: { PI_CODING_AGENT_DIR: '/default-profile' } },
          perps: { set: { PI_CODING_AGENT_DIR: '/selected-profile' } },
        },
      },
    },
    undefined,
    'perps',
    {
      execute: async (_vars, command) => {
        assert.match(command, /PI_CODING_AGENT_DIR='\/selected-profile'/);
        assert.doesNotMatch(command, /default-profile/);
        return { stdout: '{"status":"ready"}', stderr: '', exitCode: 0 };
      },
    },
  );
});
