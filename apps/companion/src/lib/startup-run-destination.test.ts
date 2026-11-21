import assert from 'node:assert/strict';
import test from 'node:test';

import {
  pendingStartupRunDestination,
  resolveStartupRunDestination,
  startupFallbackAccess,
  type StartupRunAuthority,
  startupRunDestination,
  startupWorkspaceAfterConnectionChange,
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

test('a same-profile credential change irreversibly discards the pending service link', () => {
  const service = { ...workspace, principalId: null };
  const changed = startupWorkspaceAfterConnectionChange(service, 'principal-change');
  const reconnected = startupWorkspaceAfterConnectionChange(changed, 'network');
  assert.equal(
    resolveStartupRunDestination(href, {
      ...connected,
      startupWorkspace: reconnected,
      principalId: 'another-service',
    }),
    null,
  );
});

test('an unchanged eligible service profile can claim the verified startup link', () => {
  const service = { ...workspace, principalId: null };
  const unchanged = startupWorkspaceAfterConnectionChange(service, undefined, {
    principalId: 'service',
    workspaceAccess: 'farm',
  });
  assert.equal(
    resolveStartupRunDestination(href, {
      ...connected,
      startupWorkspace: unchanged,
      principalId: 'service',
    }),
    href,
  );
});

test('ordinary Files, Diff, Gate and Timeline links are outside automatic startup replay', () => {
  assert.equal(
    startupRunDestination('/workspace/run/run-1/evidence?tab=evidence'),
    '/workspace/run/run-1/evidence?tab=evidence',
  );
  for (const tab of ['files', 'diff', 'gate', 'timeline']) {
    assert.equal(startupRunDestination('/workspace/run/run-1/' + tab + '?panel=detail'), null);
  }
});

test('a pending service link shares its first verified principal across reconnects', () => {
  const service = { ...workspace, principalId: null };
  const first = startupWorkspaceAfterConnectionChange(service, undefined, {
    principalId: 'service-A',
    workspaceAccess: 'farm',
  });
  const pendingIntent = pendingStartupRunDestination(href);
  assert.ok(pendingIntent);
  assert.equal(
    resolveStartupRunDestination(pendingIntent.href, {
      ...connected,
      principalId: 'service-A',
      startupWorkspace: first,
    }),
    href,
  );
  // Authentication can finish before the mounted index claims its pending link.
  const dropped = startupWorkspaceAfterConnectionChange(first, 'network');
  const same = startupWorkspaceAfterConnectionChange(dropped, undefined, {
    principalId: 'service-A',
    workspaceAccess: 'farm',
  });
  assert.equal(
    resolveStartupRunDestination(pendingIntent.href, {
      ...connected,
      principalId: 'service-A',
      startupWorkspace: same,
    }),
    href,
  );
  const different = startupWorkspaceAfterConnectionChange(dropped, undefined, {
    principalId: 'service-B',
    workspaceAccess: 'farm',
  });
  assert.equal(
    resolveStartupRunDestination(pendingIntent.href, {
      ...connected,
      principalId: 'service-B',
      startupWorkspace: different,
    }),
    null,
  );
  assert.equal(
    startupWorkspaceAfterConnectionChange(different, undefined, {
      principalId: 'service-A',
      workspaceAccess: 'farm',
    }),
    null,
  );
});
