import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

const calls: string[][] = [];
mock.module('../../core/index.js', {
  namedExports: {
    execFileArgv: async (argv: string[]) => {
      calls.push(argv);
      return { stdout: '42\n', stderr: '', exitCode: 0 };
    },
  },
});

const { resolvePrRef } = await import('./ticket-ref.js');

test('resolvePrRef passes a hostile branch as one literal --head value', async () => {
  const branch = 'feature/$(touch /tmp/pwned)`id`';
  assert.equal(await resolvePrRef(branch, 'owner/repo'), 'owner/repo#42');
  assert.deepEqual(calls.at(-1), [
    'gh',
    'pr',
    'list',
    '--head',
    branch,
    '--repo',
    'owner/repo',
    '--json',
    'number',
    '--jq',
    '.[0].number',
  ]);
});
