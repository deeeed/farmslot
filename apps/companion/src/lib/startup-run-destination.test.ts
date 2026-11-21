import assert from 'node:assert/strict';
import test from 'node:test';

import {
  pendingStartupRunDestination,
  resolveStartupRunDestination,
  startupFallbackAccess,
  type StartupRunAuthority,
  startupRunDestination,
} from './startup-run-destination';

const href =
  '/evidence/run-1?recipeRun=attempt-1&reviewTimeline=1&mediaTimelineAt=11388&repeat=a&repeat=b&scope=%5B%22one%22%5D';
const workspace = { profileId: 'farm-lan', gatewayUrl: 'ws://farm.test/ws', principalId: 'alice' };
const pending: StartupRunAuthority = {
  ...workspace,
  startupWorkspace: workspace,
  status: 'connecting',
  workspaceAccess: 'none',
  signedOut: false,
  refused: false,
};
const connected: StartupRunAuthority = { ...pending, status: 'connected', workspaceAccess: 'farm' };

test('cold protected links preserve their internal destination and full query until farm auth', () => {
  assert.equal(startupRunDestination(href), href);
  assert.equal(startupRunDestination('/run/run-2?tab=diff'), '/run/run-2?tab=diff');
  assert.equal(
    resolveStartupRunDestination(href, { ...pending, startupWorkspace: undefined }),
    undefined,
  );
  assert.equal(resolveStartupRunDestination(href, pending), undefined);
  assert.equal(resolveStartupRunDestination(href, connected), href);
});

test('signed-out, native-only, other-account and changed-profile cold launches cannot resume', () => {
  for (const state of [
    { ...pending, signedOut: true },
    { ...pending, refused: true },
    { ...connected, workspaceAccess: 'native' as const },
    { ...connected, principalId: 'bob' },
    { ...connected, profileId: 'other' },
    { ...connected, gatewayUrl: 'ws://other.test/ws' },
  ]) {
    assert.equal(resolveStartupRunDestination(href, state), null);
  }
});

test('external, pairing, settings and invalid targets are not captured', () => {
  for (const invalid of [
    'https://farm.test/run/run-1',
    '//farm.test/run/run-1',
    '/pair?code=secret',
    '/settings',
    '/evidence/..',
  ])
    assert.equal(startupRunDestination(invalid), null);
});

test('the first offline connection failure discards the link to allow a safe cached home', () => {
  assert.equal(
    resolveStartupRunDestination(href, {
      ...pending,
      status: 'disconnected',
      offline: true,
    }),
    null,
  );
});

test('offline fallback uses only the remembered authority of the selected startup workspace', () => {
  const offline = { ...pending, offline: true };
  assert.equal(resolveStartupRunDestination(href, offline), null);
  assert.equal(startupFallbackAccess(offline, { access: 'farm', principalId: 'alice' }), 'farm');
  assert.equal(startupFallbackAccess(offline, { access: 'farm', principalId: 'bob' }), 'none');
  assert.equal(
    startupFallbackAccess(
      { ...offline, signedOut: true },
      { access: 'farm', principalId: 'alice' },
    ),
    'none',
  );
  assert.equal(
    startupFallbackAccess(
      { ...offline, profileId: 'other' },
      { access: 'farm', principalId: 'alice' },
    ),
    'none',
  );
});

test('accepted and discarded startup links cannot replay after returning home', () => {
  for (const state of [
    connected,
    { ...pending, offline: true },
    { ...connected, principalId: 'bob' },
  ]) {
    const intent = pendingStartupRunDestination(href);
    assert.ok(intent);
    assert.notEqual(resolveStartupRunDestination(intent.href, state), undefined);
    assert.equal(intent.claim(), true);
    assert.equal(resolveStartupRunDestination(intent.href, connected), href);
    assert.equal(intent.claim(), false);
  }
});
