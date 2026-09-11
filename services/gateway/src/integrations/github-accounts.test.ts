import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { promisify } from 'node:util';

let calls = 0;
const execFile = Object.assign(() => {}, {
  [promisify.custom]: async (
    _command: string,
    args: string[],
    opts: { env: NodeJS.ProcessEnv },
  ) => {
    calls++;
    assert.deepEqual(args, ['auth', 'status', '--json', 'hosts']);
    assert.equal(opts.env.GH_TOKEN, undefined);
    assert.equal(opts.env.GITHUB_TOKEN, undefined);
    return {
      stdout: JSON.stringify({
        hosts: {
          'github.com': [
            {
              login: 'work-reader',
              active: true,
              state: 'success',
              token: 'test-secret-should-never-leave-gateway',
            },
            {
              login: 'personal-reader',
              active: false,
              state: 'success',
              token: 'second-test-secret',
            },
            { login: 'revoked-reader', state: 'error', error: 'private error text' },
          ],
        },
      }),
    };
  },
});
mock.module('node:child_process', { namedExports: { execFile } });
const { gatewayGitHubAccounts, parseGitHubAccounts } = await import('./github-accounts.js');

test('gateway inventory returns only authenticated identities and shares its cached probe', async () => {
  const [first, second] = await Promise.all([gatewayGitHubAccounts(), gatewayGitHubAccounts()]);
  assert.equal(calls, 1);
  assert.deepEqual(first, second);
  assert.deepEqual(first.accounts, [
    { host: 'github.com', login: 'work-reader', active: true },
    { host: 'github.com', login: 'personal-reader', active: false },
  ]);
  assert(!JSON.stringify(first).includes('secret'));
  assert(!JSON.stringify(first).includes('private error'));
  await gatewayGitHubAccounts();
  assert.equal(calls, 1);
  await gatewayGitHubAccounts(true);
  assert.equal(calls, 2);
});

test('account inventory handles no accounts and rejects malformed metadata', () => {
  assert.deepEqual(parseGitHubAccounts({ hosts: {} }), []);
  assert.throws(() => parseGitHubAccounts({ hosts: [] }), /Invalid/);
  assert.deepEqual(
    parseGitHubAccounts({
      hosts: {
        'github.com': [
          { state: 'success', login: 'not a login' },
          { state: 'success', login: 'valid-reader' },
        ],
      },
    }),
    [{ host: 'github.com', login: 'valid-reader', active: false }],
  );
});

test('explicit refresh during a probe queues one newer verification', async () => {
  const before = calls;
  const first = gatewayGitHubAccounts(true);
  const refresh = gatewayGitHubAccounts(true);
  const duplicate = gatewayGitHubAccounts(true);
  await Promise.all([first, refresh, duplicate]);
  assert.equal(calls, before + 2);
});
