import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import type { PREditParams } from '../integrations/github-client.js';
import { fakeGitHubService } from '../integrations/github-test-fixtures.js';
import { shouldPrepareLocalFirstPackage } from '../run-engine/publication-policy.js';

await import('../runtime/mock-pty.test-support.js');
const github = await import('../integrations/github-client.js');
const titles: string[] = [];
const fake = fakeGitHubService(github.github, {
  prView: async () => ({ title: 'feat: PROJ-2418' }),
  prEdit: async (_repo: string, _number: number, params: PREditParams) => {
    if (params.title) titles.push(params.title);
    return '';
  },
});
mock.module('../integrations/github-client.js', {
  namedExports: { ...github, github: fake },
});
const config = await import('../core/config.js');
let titleSuffix = '';
mock.module('../core/config.js', {
  namedExports: {
    ...config,
    loadProjectVars: async () => ({
      projectJson: { ci: { pr_title_suffix: titleSuffix } },
    }),
  },
});
const { updatePRTitle } = await import('./pr-publication.js');
const { makeRun, manualTicketData } = await import('./test-fixtures.js');

test('lightweight completion keeps a conventional ticket title', async () => {
  const run = makeRun({
    flowType: 'dev',
    mode: 'interactive',
    devInteractiveProfile: 'lightweight',
    ticketOrPr: 'PROJ-2418',
    ticketData: manualTicketData('ci: update checks'),
  });
  assert.equal(shouldPrepareLocalFirstPackage(run), false);
  titleSuffix = '';
  titles.length = 0;
  await updatePRTitle(run, 'fixture/repo', 2418);
  assert.deepEqual(titles, ['ci: update checks']);

  titleSuffix = '[gate]';
  titles.length = 0;
  await updatePRTitle(run, 'fixture/repo', 2418);
  assert.deepEqual(titles, ['ci: update checks [gate]']);

  titles.length = 0;
  await updatePRTitle(
    { ...run, ticketData: manualTicketData('Show market icons') },
    'fixture/repo',
    2418,
  );
  assert.deepEqual(titles, ['feat: show market icons [gate]']);

  titles.length = 0;
  await updatePRTitle(
    {
      ...run,
      flowType: 'fix-bug',
      ticketData: manualTicketData('[BUG] iOS: show the banner'),
    },
    'fixture/repo',
    2418,
  );
  assert.deepEqual(titles, ['fix: iOS: show the banner [gate]']);
});
