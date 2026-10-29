import assert from 'node:assert/strict';
import test from 'node:test';

import type { ResourceCacheConnection } from '@farmslot/protocol/client-cache';

import { parseResourceStoreIdentity, resourceIdentityFromConnection } from '../src/identity.js';

const connection: ResourceCacheConnection = {
  id: 1,
  connected: true,
  authMode: 'token',
  scope: {
    gatewayUrl: 'ws://user:password@gateway.test/ws?token=secret#fragment',
    profileId: 'one',
    principalId: 'p',
    principalGeneration: 0,
  },
  authority: { roles: [{ role: 'admin', scope: { kind: 'global' } }], workspaceAccess: 'farm' },
};

test('remembered identity stores only normalized scope and authority for the selected profile', () => {
  const identity = resourceIdentityFromConnection(connection)!;
  const raw = JSON.stringify(identity);
  assert(!raw.includes('password') && !raw.includes('secret') && !raw.includes('user:'));
  assert.deepEqual(parseResourceStoreIdentity(raw, 'ws://gateway.test/ws', 'one'), identity);
  assert.equal(parseResourceStoreIdentity(raw, 'ws://other.test/ws', 'one'), undefined);
  assert.equal(parseResourceStoreIdentity(raw, 'ws://gateway.test/ws', 'two'), undefined);
});

test('missing generations and malformed local identities cannot open authenticated stores', () => {
  assert.equal(
    resourceIdentityFromConnection({
      ...connection,
      scope: { ...connection.scope, principalGeneration: undefined },
    }),
    undefined,
  );
  assert.equal(parseResourceStoreIdentity('{broken', 'ws://gateway.test/ws', 'one'), undefined);
  assert.equal(
    parseResourceStoreIdentity('{"authMode":"token","metadata":{}}', 'ws://gateway.test/ws', 'one'),
    undefined,
  );
  const anonymous = resourceIdentityFromConnection({ ...connection, authMode: 'none' })!;
  assert.equal(anonymous.metadata.scope.principalId, undefined);
  assert.equal(anonymous.metadata.scope.principalGeneration, undefined);
});
