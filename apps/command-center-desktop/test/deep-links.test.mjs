import assert from 'node:assert/strict';
import test from 'node:test';

import { deepLinkFromRoute, routeFromDeepLink } from '../src/deep-links.mjs';
import { attentionBadge } from '../src/preferences.mjs';

const run = '123e4567-e89b-12d3-a456-426614174000';

test('deep links target runs, their gates, slots and main views', () => {
  for (const kind of ['run', 'gate']) {
    assert.equal(routeFromDeepLink(`farmslot://${kind}/${run}`), `#runs?run=${run}`);
  }
  assert.equal(routeFromDeepLink('farmslot://slot/runner-1'), '#slot/runner-1');
  assert.equal(
    routeFromDeepLink(`farmslot://slot/runner-1?runId=${run}`),
    `#slot/runner-1?runId=${run}`,
  );
  assert.equal(routeFromDeepLink('FARMSLOT://RUN/abc'), '#runs?run=abc');
  for (const view of ['fleet', 'runs', 'decisions'])
    assert.equal(routeFromDeepLink(`farmslot://${view}`), `#${view}`);
});

test('external links cannot supply authority, credentials, actions or arbitrary navigation', () => {
  for (const value of [
    null,
    '',
    'https://run/example',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'farmslot://run',
    'farmslot://user:secret@run/example',
    'farmslot://run:80/example',
    'farmslot://run/id?token=secret',
    'farmslot://slot/id?gateway=wss://evil.example',
    'farmslot://run/id?runId=other',
    'farmslot://run/id#approve',
    'farmslot://run/id/approve',
    'farmslot://slot/../run/id',
    'farmslot://run/a%2fb',
    'farmslot://run/%2e%2e',
    'farmslot://run/a\\b',
    'farmslot://run/id\n',
    'farmslot://run/' + 'x'.repeat(513),
  ])
    assert.equal(routeFromDeepLink(value), null, String(value));
});

test('copied view links round trip without copying unrelated query values', () => {
  for (const [route, expected] of [
    [`#runs?run=${run}&token=secret`, `farmslot://run/${run}`],
    [`#run/${run}`, `farmslot://run/${run}`],
    [`#slot/runner-1?runId=${run}&file=src/main.ts`, `farmslot://slot/runner-1?runId=${run}`],
    ['#decisions', 'farmslot://decisions'],
  ]) {
    assert.equal(deepLinkFromRoute(route), expected);
    assert(routeFromDeepLink(expected));
  }
  for (const route of [
    '#config',
    '#runs?run=bad%2Fid',
    '#slot/id?runId=bad%20id',
    'https://example.com',
  ])
    assert.equal(deepLinkFromRoute(route), null);
});

test('Dock badge clears zero, disconnected and unhydrated counts', () => {
  assert.equal(attentionBadge({ connected: true, ready: true, decisions: 3 }), '3');
  assert.equal(attentionBadge({ connected: true, ready: true, decisions: 0 }), '');
  assert.equal(attentionBadge({ connected: false, ready: true, decisions: 3 }), '');
  assert.equal(attentionBadge({ connected: true, ready: false, decisions: 3 }), '');
});
