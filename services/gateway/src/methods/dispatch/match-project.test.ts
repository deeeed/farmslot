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

const { dispatchMatchProject } = await import('./match-project.js');

test('dispatchMatchProject passes a branch containing command substitution as one literal string to prListFields', async () => {
  capturedHead = undefined;
  const branch = 'feature/$(touch /tmp/pwned)`id`';

  const result = await dispatchMatchProject(
    { ticketOrPr: branch, flowType: 'review-pr' },
    {
      loadConfigs: async () =>
        [
          {
            name: 'example',
            ci: { repo: 'owner/repo' },
          },
        ] as any,
    },
  );

  assert.equal(result.project, 'example');
  // The branch name must reach prListFields as the literal head filter — no shell execution.
  assert.equal(capturedHead, branch);
});
