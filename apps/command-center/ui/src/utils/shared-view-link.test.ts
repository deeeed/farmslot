import assert from 'node:assert/strict';
import { test } from 'node:test';

import { sharedViewStartupReceipt } from './shared-view-link.js';

test('a foreign fallback candidate refuses the whole shared-link startup', () => {
  const deployment = {
    commandCenterUrl: 'https://cc.example.org/',
    gatewayUrls: ['wss://farm.example.org/ws'],
  };
  assert.equal(
    sharedViewStartupReceipt(
      'https://cc.example.org/#slot/repeated-slot?sharedView=1',
      ['wss://farm.example.org/ws', 'wss://foreign.example.org/ws'],
      deployment,
    ).status,
    'refused',
  );
  assert.deepEqual(
    sharedViewStartupReceipt(
      'https://cc.example.org/#slot/repeated-slot?sharedView=1',
      ['wss://farm.example.org/ws'],
      deployment,
    ),
    { status: 'accepted', route: '#slot/repeated-slot' },
  );
});

test('ordinary navigation is unaffected by absent share-link configuration', () => {
  assert.deepEqual(
    sharedViewStartupReceipt('https://cc.example.org/#fleet', ['wss://current.example.org/ws'], {
      gatewayUrls: [],
    }),
    { status: 'ordinary' },
  );
});
