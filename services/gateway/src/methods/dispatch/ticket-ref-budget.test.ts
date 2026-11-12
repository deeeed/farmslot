import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';

import { githubQueryBudget } from '../../integrations/github-query-budget.js';
import { startGitHubFixture } from '../../integrations/github-test-fixtures.js';

// Real client middleware; GitHub is a local fixture that must never be reached here.
const fixture = await startGitHubFixture(() => ({ status: 500, body: { message: 'unexpected' } }));
process.env.FARMSLOT_GITHUB_API_URL = fixture.origin;
const fleet = await import('../../fleet/state.js');
mock.module('../../fleet/state.js', {
  namedExports: {
    ...fleet,
    loadProjectConfigs: async () => [{ name: 'app', ci: { repo: 'org/app' } }],
  },
});
const { resolvePrRef } = await import('./ticket-ref.js');
const { dispatchMatchProject } = await import('./match-project.js');

after(async () => {
  githubQueryBudget.resetForTests();
  delete process.env.FARMSLOT_GITHUB_API_URL;
  await fixture.close();
});

test('dispatch lookups respect an active GraphQL reserve even though they are forced', async () => {
  githubQueryBudget.observe('reserved-credential', {
    remaining: 0,
    cost: 1,
    resetAt: new Date(Date.now() + 120_000).toISOString(),
  });
  assert.equal(await resolvePrRef('feat/reserved', 'org/app'), 'feat/reserved');
  const matched = await dispatchMatchProject({ ticketOrPr: '42', flowType: 'review-pr' });
  assert.equal(matched.project, null);
  assert.equal(fixture.requests.length, 0, 'the reserve sent no GitHub request');
});
