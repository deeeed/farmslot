import assert from 'node:assert/strict';
import test from 'node:test';

import { notifyNightlyFailure } from './nightly-ci-alert.mjs';

const context = {
  repo: { owner: 'fixture', repo: 'repo' },
  serverUrl: 'https://github.com',
  runId: 42,
  sha: 'failed-head',
};
function client(issues) {
  const calls = [];
  return {
    calls,
    paginate: async () => issues,
    rest: {
      issues: {
        listForRepo: () => {},
        create: async (args) => calls.push(['create', args]),
        createComment: async (args) => calls.push(['comment', args]),
      },
    },
  };
}

test('nightly failure creates a visible issue with exact run and source evidence', async () => {
  const github = client([]);
  await notifyNightlyFailure(github, context);
  assert.equal(github.calls[0][0], 'create');
  assert.match(github.calls[0][1].body, /actions\/runs\/42/);
  assert.match(github.calls[0][1].body, /failed-head/);
});

test('repeated failure comments on the existing incident and notification errors remain failures', async () => {
  const github = client([{ number: 7, title: 'CI: nightly parity audit failed' }]);
  await notifyNightlyFailure(github, context);
  assert.equal(github.calls[0][0], 'comment');
  assert.equal(github.calls[0][1].issue_number, 7);
  github.rest.issues.createComment = async () => {
    throw new Error('notification denied');
  };
  await assert.rejects(() => notifyNightlyFailure(github, context), /notification denied/);
});
