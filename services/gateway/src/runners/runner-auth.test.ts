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

for (const [name, replies, calls, outcome] of [
  ['a timed-out check is retried once', [{ exitCode: 124 }, { stdout: '{"status":"ready"}' }], 2],
  [
    'two timeouts name the timeout',
    [{ exitCode: 124 }, { exitCode: 124 }],
    2,
    /auth_check_unavailable \(the check did not finish within 30 s, twice\)/,
  ],
  [
    "the runner's own timeout is retried and named",
    Array(2).fill({
      stdout: '{"status":"invalid","reason":"auth_check_unavailable","cause":"timeout"}',
      exitCode: 1,
    }),
    2,
    /\(the runner's own auth check timed out, twice\)/,
  ],
  [
    "the runner's failed check names its exit code",
    [
      {
        stdout:
          '{"status":"invalid","reason":"auth_check_unavailable","cause":"failed","exitCode":3}',
        exitCode: 1,
      },
    ],
    1,
    /\(the runner's auth check failed \(exit 3\)\)/,
  ],
  [
    "a signal kill names the runner's signal",
    [
      {
        stdout:
          '{"status":"invalid","reason":"auth_check_unavailable","cause":"failed","signal":"SIGKILL"}',
        exitCode: 1,
      },
    ],
    1,
    /\(the runner's auth check failed \(SIGKILL\)\)/,
  ],
  [
    'an unknown cause is never looked up on the prototype',
    [{ stdout: '{"status":"invalid","cause":"constructor"}', exitCode: 1 }],
    1,
    /\(the check reported invalid without a known reason\)/,
  ],
  [
    'output without a verdict names the exit code',
    [{ stdout: 'secret-token', exitCode: 2 }],
    1,
    /\(the check exited 2 without a verdict\)/,
  ],
  ['a ready verdict runs one check', [{ stdout: '{"status":"ready"}' }], 1],
  [
    'a known reason runs one check',
    [{ stdout: '{"status":"not_ready","reason":"credentials_not_configured"}', exitCode: 1 }],
    1,
    /credentials_not_configured\. Restore the provider login/,
  ],
] as const) {
  test(`auth check cause: ${name}`, async () => {
    let invoked = 0;
    const action = assertRunnerAuthBeforeLaunch(
      makeVars(),
      'pi',
      'anthropic/claude-haiku-4-5',
      {},
      undefined,
      undefined,
      {
        execute: async () => {
          const reply = replies[invoked++];
          return { stdout: '', exitCode: 0, ...reply, stderr: 'secret-token' };
        },
      },
    );
    if (outcome)
      await assert.rejects(action, (error: Error) => {
        assert.match(error.message, outcome);
        assert.doesNotMatch(error.message, /secret-token/);
        return true;
      });
    else await action;
    assert.equal(invoked, calls);
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
