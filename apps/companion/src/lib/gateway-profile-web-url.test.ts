import assert from 'node:assert/strict';
import { test } from 'node:test';

import { commandCenterUrlForProfile } from './gateway-profile-web-url';
import type { GatewayProfile } from './gateway-profiles';

const saved: GatewayProfile = {
  id: 'paired-a',
  name: 'A',
  kind: 'remote',
  url: 'wss://a.example/ws',
  commandCenterUrl: 'https://cc-a.example/',
};
test('re-pairing the same endpoint retains its URL, while explicit clearing wins', () => {
  const incoming: GatewayProfile = {
    id: saved.id,
    name: 'A renewed',
    kind: 'remote',
    url: saved.url,
  };
  assert.equal(commandCenterUrlForProfile(incoming, saved), 'https://cc-a.example/');
  assert.equal(commandCenterUrlForProfile({ ...incoming, commandCenterUrl: '' }, saved), '');
});
test('a configured profile ID never transfers another endpoint’s web base', () => {
  assert.equal(
    commandCenterUrlForProfile(
      { ...saved, url: 'wss://b.example/ws', commandCenterUrl: undefined },
      saved,
    ),
    undefined,
  );
  assert.equal(
    commandCenterUrlForProfile(
      { ...saved, id: 'paired-other', commandCenterUrl: undefined },
      saved,
    ),
    undefined,
  );
});
