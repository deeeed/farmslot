import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Command, CommanderError } from 'commander';
import { WebSocketServer } from 'ws';

import type { CredentialIssueResult, PersonSessionGrant } from '@farmslot/protocol';

import { loadProfiles, saveProfiles } from '../gateway-profiles.js';

import {
  assertSecretFileCreatable,
  credentialIssueMachineResult,
  persistOwnerCredential,
  registerCredentialCommands,
  writeSecretFile,
} from './credential.js';

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

test('activation saves only a verified person device and preserves an unrelated active profile', async (t) => {
  const previousHome = process.env.FARMSLOT_HOME;
  const home = mkdtempSync(join(tmpdir(), 'farmslot-cli-activation-'));
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  t.after(async () => {
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
  });
  server.on('connection', (socket) =>
    socket.on('message', (data) => {
      const request = JSON.parse(String(data));
      const person =
        request.params?.token === 'owner-secret' || request.params?.token === 'rotated';
      if (request.method === 'auth.connect')
        socket.send(
          JSON.stringify({
            type: 'res',
            id: request.id,
            ...(person
              ? {
                  ok: false,
                  error: {
                    code: 'AUTH_PERSON_SESSION_REQUIRED',
                    message: 'Create a device session.',
                  },
                }
              : {
                  ok: true,
                  payload: {
                    ok: true,
                    authMode: 'token',
                    clientKind: 'ui',
                    authenticatedAt: Date.now(),
                    capabilities: { httpBearerAuth: true, voiceInstructionFormatting: false },
                    principal: {
                      id: 'automation',
                      subjectKind: 'service',
                      displayName: 'Automation',
                      roles: [],
                    },
                  },
                }),
          }),
        );
      else if (request.method === 'auth.session.exchange')
        socket.send(
          JSON.stringify({ type: 'res', id: request.id, ok: true, payload: activationGrant() }),
        );
    }),
  );
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `ws://127.0.0.1:${address.port}/ws`;
  process.env.FARMSLOT_HOME = home;
  try {
    saveProfiles({
      active: 'other',
      gateways: { other: { url: 'wss://other.example/ws', authMode: 'token', secret: 'other' } },
    });
    const name = await persistOwnerCredential(url, undefined, 'owner-secret');
    assert.equal(name, 'activated-gateway');
    const saved = loadProfiles();
    assert.equal(saved.active, 'other');
    assert.equal(saved.gateways.other.secret, 'other');
    assert.ok(saved.gateways[name].personSession);
    assert.equal(saved.gateways[name].secret, undefined);
    const bytes = JSON.stringify(saved);
    assert.ok(!bytes.includes('owner-secret') && !bytes.includes('fsa_'));
    assert.equal(
      await persistOwnerCredential(`WS://127.0.0.1:${address.port}/ws/`, undefined, 'rotated'),
      name,
    );
    assert.equal(loadProfiles().gateways[name].secret, undefined);
    await persistOwnerCredential(url, 'automation', 'service-secret');
    assert.equal(loadProfiles().gateways.automation.secret, 'service-secret');
    assert.equal(loadProfiles().gateways.automation.personSession, undefined);
  } finally {
    if (previousHome === undefined) delete process.env.FARMSLOT_HOME;
    else process.env.FARMSLOT_HOME = previousHome;
  }
});

function activationGrant(): PersonSessionGrant {
  const issued = Date.now();
  return {
    accessToken: `fsa_${'b'.repeat(32)}_${'s'.repeat(43)}`,
    accessExpiresAt: new Date(issued + 3600_000).toISOString(),
    refreshToken: `fsr_${'a'.repeat(32)}_${'r'.repeat(43)}`,
    session: {
      id: 'a'.repeat(32),
      principalId: 'owner',
      principalGeneration: 0,
      deviceName: 'CLI fixture',
      deviceKind: 'cli',
      createdAt: new Date(issued).toISOString(),
      lastRefreshedAt: new Date(issued).toISOString(),
      refreshExpiresAt: new Date(issued + 30 * 24 * 3600_000).toISOString(),
      revokedAt: null,
    },
  };
}

test('writeSecretFile writes 0600, byte-exact, and refuses to overwrite', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'farmslot-secret-file-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const target = join(dir, 'node.secret');

  const written = writeSecretFile(target, 'fs_secret_+/=value');

  assert.equal(written, target);
  assert.equal(readFileSync(target, 'utf8'), 'fs_secret_+/=value', 'no trailing newline');
  assert.equal(statSync(target).mode & 0o777, 0o600);
  // Exclusive create: a second write to the same path must refuse, and the
  // original secret must survive.
  assert.throws(() => writeSecretFile(target, 'other'), /EEXIST/);
  assert.equal(readFileSync(target, 'utf8'), 'fs_secret_+/=value');
});

test('secret-file pre-flight rejects existing targets and missing parents before issuance', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'farmslot-secret-preflight-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fresh = join(dir, 'new.secret');
  assertSecretFileCreatable(fresh); // must not throw

  writeSecretFile(fresh, 's');
  assert.throws(() => assertSecretFileCreatable(fresh), /already exists/);
  assert.throws(
    () => assertSecretFileCreatable(join(dir, 'no-such-dir', 'x.secret')),
    /parent directory does not exist/,
  );
});

test('credential issuance rejects the retired checkout writer before any issuance', () => {
  const program = new Command()
    .exitOverride()
    .configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerCredentialCommands(program);
  assert.throws(
    () =>
      program.parse([
        'node',
        'farmslot',
        'credential',
        'issue',
        '--principal',
        'test-node',
        '--write-node-env',
      ]),
    (error) => error instanceof CommanderError && error.code === 'commander.unknownOption',
  );
});
