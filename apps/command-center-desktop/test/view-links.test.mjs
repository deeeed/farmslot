import assert from 'node:assert/strict';
import test from 'node:test';

import { validViewRoute, viewLinkFromRoute, viewRouteFromLink } from '../src/view-links.mjs';

test('view links preserve safe navigation state and round trip', () => {
  const route = '#runs?projects=core%2Cmobile&file=src%2Fmain.ts';
  const link = viewLinkFromRoute(route);
  assert.equal(link, `farmslot://view/${route}`);
  assert.equal(viewRouteFromLink(link), route);
  assert.equal(validViewRoute('#slot/runner-1?runId=run-1&contextId=ctx-1'), true);
  assert.equal(validViewRoute('#config/pool/macwork'), true);
  assert.equal(validViewRoute('#config/flows/fix-bug/interactive/phase/metamask-farm'), true);
});

test('selected backlog items and status filters are shareable', () => {
  for (const route of [
    '#backlog?projects=farmslot-farm&item=26100923-29a3-46a3-bf0d-8040f9daa80c',
    '#backlog?backlogProject=farmslot-farm&backlogStatus=candidate&item=26100923-29a3-46a3-bf0d-8040f9daa80c&dispatchConfig=1',
    '#backlog?projects=farmslot-farm&item=26100923-29a3-46a3-bf0d-8040f9daa80c&spec=1',
    '#backlog?create=1&slotSelector=1',
  ]) {
    const link = viewLinkFromRoute(route);
    assert.equal(link, `farmslot://view/${route}`);
    assert.equal(viewRouteFromLink(link), route);
  }
});

test('view links reject credentials, actions and unknown parameters', () => {
  for (const route of [
    '#runs?token=secret',
    '#runs?gateway=wss%3A%2F%2Fevil.example',
    '#runs?approve=1',
    '#not-a-route',
    '#runs?file=%00secret',
    '#backlog?item=26100923-29a3-46a3-bf0d-8040f9daa80c&token=secret',
  ]) {
    assert.equal(validViewRoute(route), false, route);
    assert.equal(viewLinkFromRoute(route), null, route);
  }
  assert.equal(viewRouteFromLink('farmslot://view/#runs?token=secret'), null);
  assert.equal(viewRouteFromLink('farmslot-dev://view/#runs'), null);
});
