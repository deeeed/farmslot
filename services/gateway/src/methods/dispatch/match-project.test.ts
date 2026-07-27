import assert from 'node:assert/strict';
import test from 'node:test';

import { dispatchMatchProject } from './match-project.js';

test('dispatchMatchProject passes a branch containing command substitution as one argv value', async () => {
  const branch = 'feature/$(touch /tmp/pwned)`id`';
  let transmitted: string[] | undefined;

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
      runArgv: async (argv) => {
        transmitted = argv;
        return { stdout: '42\n', stderr: '', exitCode: 0 };
      },
    },
  );

  assert.equal(result.project, 'example');
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
