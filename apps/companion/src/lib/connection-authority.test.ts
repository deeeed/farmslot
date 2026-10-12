import assert from 'node:assert/strict';
import test from 'node:test';

import { currentFarmConnection } from './connection-authority';
import type { GatewayClient } from './gateway-client';

test('a delayed farm result cannot repopulate state after principal, access or generation changes', async () => {
  type Scope = Pick<
    GatewayClient,
    'connectionGeneration' | 'connectionState' | 'authenticatedPrincipal' | 'workspaceAccess'
  >;
  const client: { -readonly [K in keyof Scope]: Scope[K] } = {
    connectionGeneration: 1,
    connectionState: 'connected',
    workspaceAccess: 'farm',
    authenticatedPrincipal: { id: 'admin', displayName: 'Admin', subjectKind: 'person', roles: [] },
  };
  for (const change of [
    () => {
      client.authenticatedPrincipal = { ...client.authenticatedPrincipal!, id: 'owner' };
    },
    () => {
      client.workspaceAccess = 'native';
    },
    () => {
      client.connectionGeneration++;
    },
    () => {
      client.connectionState = 'disconnected';
    },
  ]) {
    client.connectionState = 'connected';
    client.workspaceAccess = 'farm';
    const current = currentFarmConnection(client);
    assert.equal(current(), true);
    let release!: (value: string) => void;
    const delayed = new Promise<string>((resolve) => {
      release = resolve;
    });
    let visible: string | null = null;
    const refresh = delayed.then((result) => {
      if (current()) visible = result;
    });
    change();
    release('private-admin-marker');
    await refresh;
    assert.equal(visible, null);
  }
});

test('farm reads also bind the profile, authorization epoch and selected client', () => {
  const client = {
    connectionGeneration: 1,
    connectionState: 'connected',
    workspaceAccess: 'farm',
    authenticatedPrincipal: { id: 'admin' },
  } as GatewayClient;
  const authority = {
    client: client as GatewayClient | null,
    activeProfileId: 'first' as string | null,
    authorityEpoch: 1,
  };
  for (const change of [
    () => {
      authority.activeProfileId = 'second';
    },
    () => {
      authority.authorityEpoch++;
    },
    () => {
      authority.client = null;
    },
  ]) {
    authority.client = client;
    authority.activeProfileId = 'first';
    const current = currentFarmConnection(client, () => authority);
    assert.equal(current(), true);
    change();
    assert.equal(current(), false);
  }
});
