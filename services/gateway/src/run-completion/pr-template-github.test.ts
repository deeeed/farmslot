import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { startGitHubFixture } from '../integrations/github-test-fixtures.js';

// GitHub's contents API: a missing file is HTTP 404 with a JSON message.
let present: Record<string, string> = {};
let failure: number | undefined;
const fixture = await startGitHubFixture((request) => {
  if (failure) return { status: failure, body: { message: 'Server Error' } };
  const file = request.path.replace(/^\/repos\/org\/app\/contents\//, '');
  const body = present[file];
  return body === undefined
    ? { status: 404, body: { message: 'Not Found' } }
    : { body: { content: Buffer.from(body).toString('base64') } };
});
process.env.FARMSLOT_GITHUB_API_URL = fixture.origin;
const { readGitHubPrTemplate } = await import('./pr-template.js');

after(async () => {
  delete process.env.FARMSLOT_GITHUB_API_URL;
  await fixture.close();
});

test('an HTTP 404 from the contents API moves to the next PR template candidate', async () => {
  present = { '.github/PULL_REQUEST_TEMPLATE.md': '## Summary\n' };
  assert.deepEqual(await readGitHubPrTemplate('org/app', 'main'), {
    path: '.github/PULL_REQUEST_TEMPLATE.md',
    body: '## Summary\n',
  });
  present = {};
  assert.equal(await readGitHubPrTemplate('org/app', 'release'), null);
  failure = 500;
  await assert.rejects(readGitHubPrTemplate('org/app', 'other'), /HTTP 500/);
  failure = undefined;
});
