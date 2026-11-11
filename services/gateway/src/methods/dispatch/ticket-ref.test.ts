import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import * as githubClientMod from '../../integrations/github-client.js';

// Branch name with shell metacharacters — must arrive at prListFields unchanged, not executed.
mock.module('../../integrations/github-client.js', {
  namedExports: {
    ...githubClientMod,
    github: {
      ...githubClientMod.github,
      prListFields: async (
        _repo: string,
        _fields: string[],
        opts?: { head?: string; limit?: number },
      ) => {
        capturedHead = opts?.head;
        return [{ number: 42 }];
      },
    },
  },
});

let capturedHead: string | undefined;

const { normalizeTicketRef, resolvePrRef, validateTicketRef } = await import('./ticket-ref.js');

test('shared Jira parsing preserves existing URL normalization and branch references', () => {
  assert.equal(
    normalizeTicketRef(' https://consensys.atlassian.net/browse/tat-4355/ '),
    'TAT-4355',
  );
  for (const ref of ['TAT-4355', 'tat-4355', 'fix-123', 'release-7.70.0'])
    assert.equal(normalizeTicketRef(ref), ref);
});

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

test('resolvePrRef passes a branch containing command substitution as one literal string to prListFields', async () => {
  capturedHead = undefined;
  const branch = 'feature/$(touch /tmp/pwned)`id`';

  const resolved = await resolvePrRef(branch, 'owner/repo');

  assert.equal(resolved, 'owner/repo#42');
  // The branch name must reach prListFields as the literal head filter — no shell execution.
  assert.equal(capturedHead, branch);
});
