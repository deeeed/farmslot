import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

const calls: string[][] = [];
mock.module('../../core/index.js', {
  namedExports: {
    execFileArgv: async (argv: string[]) => {
      calls.push(argv);
      return { stdout: '73\n', stderr: '', exitCode: 0 };
    },
  },
});
mock.module('../../fleet/state.js', {
  namedExports: {
    loadProjectConfigs: async () => [{ name: 'demo', ci: { repo: 'owner/repo' } }],
  },
});

const { dispatchMatchProject } = await import('./match-project.js');

test('dispatchMatchProject passes a hostile branch as one literal --head value', async () => {
  const branch = 'feature/$(touch /tmp/pwned)`id`';
  const result = await dispatchMatchProject({ ticketOrPr: branch, flowType: 'review-pr' });
  assert.equal(result.normalizedTicket, 'owner/repo#73');
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
