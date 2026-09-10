import assert from 'node:assert/strict';
import { test } from 'node:test';

import { githubRequestCacheKey, isGhPRChecksPendingExit } from './github-client.js';

test('explicit account caches isolate principals, credentials and ambient requests', () => {
  const args = ['api', 'repos/owner/repo/pulls/1'];
  const account = { host: 'github.com', token: 'test-credential-one', scope: 'principal-a' };
  const key = githubRequestCacheKey(args, account);
  assert(!key.includes(account.token));
  assert.notEqual(key, githubRequestCacheKey(args));
  assert.notEqual(key, githubRequestCacheKey(args, { ...account, scope: 'principal-b' }));
  assert.notEqual(key, githubRequestCacheKey(args, { ...account, token: 'test-credential-two' }));
  assert.notEqual(key, githubRequestCacheKey(args, { ...account, host: 'github.example.com' }));
  assert.equal(key, githubRequestCacheKey([...args], { ...account }));
});

test('isGhPRChecksPendingExit preserves pending pr checks stdout', () => {
  assert.equal(
    isGhPRChecksPendingExit(
      ['pr', 'checks', '123', '--repo', 'owner/repo', '--json', 'name,bucket'],
      { code: 8, stdout: '[{"name":"lint","bucket":"pending"}]\n' },
    ),
    true,
  );
});

test('isGhPRChecksPendingExit rejects non-data or non-check failures', () => {
  assert.equal(isGhPRChecksPendingExit(['pr', 'checks', '123'], { code: 8, stdout: '' }), false);
  assert.equal(isGhPRChecksPendingExit(['pr', 'view', '123'], { code: 8, stdout: '{}' }), false);
  assert.equal(isGhPRChecksPendingExit(['pr', 'checks', '123'], { code: 1, stdout: '{}' }), false);
});
