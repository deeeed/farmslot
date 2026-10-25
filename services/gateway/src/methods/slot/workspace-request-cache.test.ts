import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

await import('../../runtime/mock-pty.test-support.js');
const github = await import('../../integrations/github-client.js');
const forceFlags: Array<boolean | undefined> = [];
const request: typeof github.ghRequest = async (_args, options) => {
  forceFlags.push(options?.force);
  return { stdout: '[]', stderr: '' };
};
mock.module('../../integrations/github-client.js', {
  namedExports: { ...github, ghRequest: request },
});
const { readMergedPreparePullRequests } = await import('./unmerged-work.js');

test('status publication reads use the request cache while prepare keeps fresh publication evidence', async () => {
  await readMergedPreparePullRequests('example/app', 'a'.repeat(40), 5000, false);
  await readMergedPreparePullRequests('example/app', 'a'.repeat(40));
  assert.deepEqual(forceFlags, [false, true]);
});
