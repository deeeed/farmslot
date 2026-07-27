import assert from 'node:assert/strict';
import test from 'node:test';

import { resolvePrRef } from './ticket-ref.js';

test('resolvePrRef passes a branch containing command substitution as one literal argv value', async () => {
  const branch = 'feature/$(touch /tmp/pwned)`id`';
  let transmitted: string[] | undefined;

  const resolved = await resolvePrRef(branch, 'owner/repo', async (argv) => {
    transmitted = argv;
    return { stdout: '42\n', stderr: '', exitCode: 0 };
  });

  assert.equal(resolved, 'owner/repo#42');
  assert.deepEqual(transmitted, [
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
