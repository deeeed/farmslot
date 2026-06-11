import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  assertGatewayUrl,
  assertProfileName,
  DEFAULT_GATEWAY_URL,
  type GatewayProfilesFile,
  loadProfiles,
  profileCredential,
  profilesPath,
  resolveGatewayTarget,
  saveProfiles,
} from './gateway-profiles.js';

function tmpStore(): string {
  return join(mkdtempSync(join(tmpdir(), 'fs-gw-')), 'gateways.json');
}

test('profilesPath honors FARMSLOT_HOME', () => {
  assert.equal(profilesPath({ FARMSLOT_HOME: '/x' }), '/x/gateways.json');
});

test('save/load round-trips and enforces 0600', () => {
  const path = tmpStore();
  const profiles: GatewayProfilesFile = {
    active: 'lab',
    gateways: { lab: { url: 'wss://lab:7777', authMode: 'token', secret: 's3cret' } },
  };
  saveProfiles(profiles, path);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(loadProfiles(path), profiles);
  // Empty store when the file does not exist yet.
  assert.deepEqual(loadProfiles(join(tmpdir(), 'nope', 'gateways.json')), { gateways: {} });
});

test('name and url validation reject malformed input', () => {
  assert.doesNotThrow(() => assertProfileName('lab-2'));
  assert.throws(() => assertProfileName('Lab'), /kebab-case/);
  assert.doesNotThrow(() => assertGatewayUrl('wss://h:7777'));
  assert.throws(() => assertGatewayUrl('http://h'), /ws:\/\/ or wss:\/\//);
});

test('profileCredential maps authMode onto the auth.connect shape', () => {
  assert.deepEqual(profileCredential({ url: 'ws://x', authMode: 'token', secret: 't' }), {
    token: 't',
  });
  assert.deepEqual(profileCredential({ url: 'ws://x', authMode: 'password', secret: 'p' }), {
    password: 'p',
  });
  assert.equal(profileCredential({ url: 'ws://x' }), undefined);
});

test('resolveGatewayTarget precedence: url > gateway > env > active > default', () => {
  const profiles: GatewayProfilesFile = {
    active: 'home',
    gateways: {
      home: { url: 'ws://home:7777', authMode: 'token', secret: 'h' },
      lab: { url: 'wss://lab:7777', authMode: 'password', secret: 'l' },
    },
  };

  assert.deepEqual(resolveGatewayTarget({ url: 'ws://x' }, { GW_URL: 'ws://env' }, profiles), {
    url: 'ws://x',
    source: 'url-flag',
  });
  assert.deepEqual(resolveGatewayTarget({ gateway: 'lab' }, { GW_URL: 'ws://env' }, profiles), {
    url: 'wss://lab:7777',
    credential: { password: 'l' },
    profileName: 'lab',
    source: 'gateway-flag',
  });
  // GW_URL keeps its pre-profile behavior so existing scripts never change target.
  assert.deepEqual(resolveGatewayTarget({}, { GW_URL: 'ws://env' }, profiles), {
    url: 'ws://env',
    source: 'env',
  });
  assert.deepEqual(resolveGatewayTarget({}, {}, profiles), {
    url: 'ws://home:7777',
    credential: { token: 'h' },
    profileName: 'home',
    source: 'active-profile',
  });
  assert.deepEqual(resolveGatewayTarget({}, {}, { gateways: {} }), {
    url: DEFAULT_GATEWAY_URL,
    source: 'default',
  });
});

test('resolveGatewayTarget rejects unknown --gateway with an actionable hint', () => {
  assert.throws(
    () => resolveGatewayTarget({ gateway: 'nope' }, {}, { gateways: {} }),
    /farmslot gateway add nope/,
  );
});

test('secrets never serialize into anything but the store file', () => {
  const path = tmpStore();
  saveProfiles(
    { gateways: { lab: { url: 'ws://l', authMode: 'token', secret: 'topsecret' } } },
    path,
  );
  // The store contains it; redaction tests for command output live with the commands.
  assert.match(readFileSync(path, 'utf-8'), /topsecret/);
});
