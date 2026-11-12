import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';
import { promisify } from 'node:util';

interface Spawn {
  file: string;
  args: string[];
  cwd?: string;
  env: NodeJS.ProcessEnv;
}
const spawns: Spawn[] = [];
let reply: () => Promise<{ stdout: string; stderr: string }>;
const fakeExecFile = Object.assign(
  () => {
    throw new Error('Use the promisified process adapter');
  },
  {
    [promisify.custom]: async (
      file: string,
      args: string[],
      options: { cwd?: string; env: NodeJS.ProcessEnv },
    ) => {
      spawns.push({ file, args, cwd: options.cwd, env: options.env });
      return reply();
    },
  },
);
mock.module('node:child_process', { namedExports: { execFile: fakeExecFile } });
const { githubCli } = await import('./github-cli.js');

const tokenVariables = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
];
const previous = Object.fromEntries(tokenVariables.map((name) => [name, process.env[name]]));
for (const name of tokenVariables) process.env[name] = `inherited-${name}`;
after(() => {
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

test('the checkout PR lookup is base’s gh pr list, run in the checkout on the keyring', async () => {
  reply = async () => ({ stdout: '{"number":42,"baseRefName":"main"}\n', stderr: '' });
  spawns.length = 0;
  assert.deepEqual(await githubCli.checkoutPRForBranch('/slots/one', 'feat/a'), {
    number: 42,
    baseRefName: 'main',
  });
  const [spawn] = spawns;
  assert.equal(spawn?.file, 'gh');
  assert.deepEqual(spawn?.args, [
    'pr',
    'list',
    '--head',
    'feat/a',
    '--json',
    'number,baseRefName',
    '--jq',
    '.[0]',
  ]);
  assert.equal(spawn?.cwd, '/slots/one');
  assert.equal(spawn?.env.GH_TOKEN, undefined, 'the keyring wins over GH_TOKEN');
  reply = async () => ({ stdout: '', stderr: '' });
  assert.equal(await githubCli.checkoutPRForBranch('/slots/one', 'none'), null);
});

test('keyring reads drop the token variables gh would prefer and never echo gh output', async () => {
  spawns.length = 0;
  reply = async () => ({ stdout: 'keyring-token\n', stderr: '' });
  assert.equal(await githubCli.authToken('github.com', 'reviewer'), 'keyring-token');
  assert.deepEqual(spawns[0]?.args, [
    'auth',
    'token',
    '--hostname',
    'github.com',
    '--user',
    'reviewer',
  ]);
  for (const name of tokenVariables) assert.equal(spawns[0]?.env[name], undefined, name);

  reply = async () => Promise.reject(new Error('gh printed secret-material'));
  await assert.rejects(githubCli.authToken('github.com'), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(
      error.message,
      'GitHub account default@github.com is unavailable in the gateway keyring',
    );
    return true;
  });

  reply = async () => ({ stdout: '{"hosts":{}}', stderr: '' });
  assert.deepEqual(await githubCli.authStatus(), { hosts: {} });
  assert.deepEqual(spawns.at(-1)?.args, ['auth', 'status', '--json', 'hosts']);
  for (const name of tokenVariables) assert.equal(spawns.at(-1)?.env[name], undefined, name);
});

test('each gh command is counted under its host operation in the exec metrics', async () => {
  const { gatewayPerformance } = await import('../observability/performance.js');
  const calls = (operation: string) =>
    gatewayPerformance
      .snapshot()
      .counters.filter(
        (row) =>
          row.name === 'farmslot_exec_calls_total' && row.labels.method === `host:${operation}`,
      )
      .reduce((sum, row) => sum + row.value, 0);
  const before = ['authToken', 'authStatus', 'checkoutPRForBranch'].map((name) =>
    calls(`githubCli.${name}`),
  );
  reply = async () => ({ stdout: '{"hosts":{}}', stderr: '' });
  await githubCli.authStatus();
  reply = async () => ({ stdout: 'keyring-token\n', stderr: '' });
  await githubCli.authToken('github.com');
  reply = async () => ({ stdout: '', stderr: '' });
  await githubCli.checkoutPRForBranch('/slots/one', 'feat/a');
  const after = ['authToken', 'authStatus', 'checkoutPRForBranch'].map((name) =>
    calls(`githubCli.${name}`),
  );
  assert.deepEqual(
    after.map((count, i) => count - (before[i] ?? 0)),
    [1, 1, 1],
  );
});
