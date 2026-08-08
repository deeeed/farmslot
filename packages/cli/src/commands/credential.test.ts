import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { CredentialIssueResult } from '@farmslot/protocol';

import { loadProfiles, saveProfiles } from '../gateway-profiles.js';

import { credentialIssueMachineResult, persistOwnerCredential } from './credential.js';

test('credential issue machine output never contains either one-time secret', () => {
  const issue: CredentialIssueResult = {
    credential: {
      id: 'credential-1',
      principalId: 'sam',
      displayName: 'sam-laptop',
      origin: 'issued',
      createdAt: '2026-08-06T00:00:00.000Z',
      revokedAt: null,
    },
    secret: 'one-time-user-secret',
    activationLatched: true,
    adminGrant: {
      credential: {
        id: 'credential-2',
        principalId: 'owner',
        displayName: 'owner',
        origin: 'issued',
        createdAt: '2026-08-06T00:00:00.000Z',
        revokedAt: null,
      },
      secret: 'one-time-owner-secret',
    },
  };
  const rendered = JSON.stringify(credentialIssueMachineResult(issue));
  assert.doesNotMatch(rendered, /one-time-user-secret|one-time-owner-secret/u);
  assert.match(rendered, /"secretReturned":true/u);
});

test('activation persists the owner secret without overwriting an unrelated active profile', () => {
  const previousHome = process.env.FARMSLOT_HOME;
  process.env.FARMSLOT_HOME = mkdtempSync(join(tmpdir(), 'farmslot-cli-activation-'));
  try {
    saveProfiles({
      active: 'other',
      gateways: { other: { url: 'wss://other.example/ws', authMode: 'token', secret: 'other' } },
    });
    const name = persistOwnerCredential('ws://127.0.0.1:8801', undefined, 'owner-secret');
    assert.equal(name, 'activated-gateway');
    assert.deepEqual(loadProfiles(), {
      active: 'other',
      gateways: {
        other: { url: 'wss://other.example/ws', authMode: 'token', secret: 'other' },
        'activated-gateway': {
          url: 'ws://127.0.0.1:8801',
          authMode: 'token',
          secret: 'owner-secret',
        },
      },
    });
  } finally {
    if (previousHome === undefined) delete process.env.FARMSLOT_HOME;
    else process.env.FARMSLOT_HOME = previousHome;
  }
});
