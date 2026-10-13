import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeTicketRef, resolvePrRef, validateTicketRef } from './ticket-ref.js';

test('QA replay accepts admitted task titles while other flows retain their reference grammar', () => {
  const title = 'Recorded iOS AC3 after two local passes';
  for (const input of [title, 'PROJ-2585', 'https://github.com/example/app/pull/42']) {
    assert.doesNotThrow(() => validateTicketRef(normalizeTicketRef(input), 'qa'));
  }
  for (const empty of ['', '  '])
    assert.throws(() => validateTicketRef(empty, 'qa'), /QA requires a task title/);
  for (const flow of ['fix-bug', 'review-pr'])
    assert.throws(() => validateTicketRef(title, flow), /Invalid .* reference/);
});

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
