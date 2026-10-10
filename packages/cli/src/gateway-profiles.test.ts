import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
  profileForUrl,
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
  // GW_URL keeps its target and never borrows the secret of a profile for a
  // different gateway. A remote one takes only an explicit env credential, so a
  // .env-file secret meant for another gateway never reaches it.
  assert.deepEqual(resolveGatewayTarget({}, { GW_URL: 'ws://env' }, profiles), {
    url: 'ws://env',
    credential: null,
    source: 'env',
  });
  assert.deepEqual(
    resolveGatewayTarget({}, { GW_URL: 'ws://env', FARMSLOT_GATEWAY_TOKEN: 'explicit' }, profiles),
    { url: 'ws://env', credential: { token: 'explicit' }, source: 'env' },
  );
  // Loopback GW_URL (a dev checkout's .env.ports) keeps .env discovery.
  for (const GW_URL of ['ws://localhost:7801', 'ws://127.0.0.1:7801', 'ws://[::1]:7801']) {
    assert.deepEqual(resolveGatewayTarget({}, { GW_URL }, profiles), {
      url: GW_URL,
      source: 'env',
    });
  }
  // A worker's GW_URL naming a stored profile's gateway reuses that profile's
  // credential; scheme/host case, default port and trailing slash are normalized.
  assert.deepEqual(resolveGatewayTarget({}, { GW_URL: 'WSS://LAB:7777/' }, profiles), {
    url: 'WSS://LAB:7777/',
    credential: { password: 'l' },
    profileName: 'lab',
    source: 'env',
  });
  assert.deepEqual(
    resolveGatewayTarget(
      {},
      { GW_URL: 'ws://gw.local' },
      { gateways: { node: { url: 'ws://gw.local:80/', authMode: 'token', secret: 'n' } } },
    ),
    { url: 'ws://gw.local', credential: { token: 'n' }, profileName: 'node', source: 'env' },
  );
  // Same host, other port or scheme is another gateway.
  for (const GW_URL of ['ws://lab:7778', 'ws://lab:7777']) {
    assert.deepEqual(resolveGatewayTarget({}, { GW_URL }, profiles), {
      url: GW_URL,
      credential: null,
      source: 'env',
    });
  }
  // The matching profile has no secret: no credential, and no discovery either.
  assert.deepEqual(
    resolveGatewayTarget(
      {},
      { GW_URL: 'ws://localhost:7777' },
      { gateways: { bare: { url: 'ws://localhost:7777' } } },
    ),
    { url: 'ws://localhost:7777', credential: null, profileName: 'bare', source: 'env' },
  );
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
  // Profile WITHOUT a stored secret: credential must be null (not undefined),
  // so the client never borrows env secrets for a remote profile target.
  assert.deepEqual(
    resolveGatewayTarget({ gateway: 'bare' }, {}, { gateways: { bare: { url: 'ws://b' } } }),
    { url: 'ws://b', credential: null, profileName: 'bare', source: 'gateway-flag' },
  );
});

test('resolveGatewayTarget ignores a corrupt store for default targets', () => {
  // profilesOverride simulating loadProfiles() throwing: --url never calls the
  // loader, and GW_URL only looks for a matching profile, so corruption is ignored.
  let loaderCalls = 0;
  const throwingProfiles: GatewayProfilesFile = {
    get gateways(): Record<string, never> {
      loaderCalls += 1;
      throw new Error('boom');
    },
  };
  assert.deepEqual(resolveGatewayTarget({ url: 'ws://x' }, {}, throwingProfiles), {
    url: 'ws://x',
    source: 'url-flag',
  });
  assert.deepEqual(resolveGatewayTarget({}, { GW_URL: 'ws://env' }, throwingProfiles), {
    url: 'ws://env',
    credential: null,
    source: 'env',
  });
  assert.equal(loaderCalls, 1);
});

test('profileForUrl is the one URL lookup: normalized, active profile first', () => {
  const profiles: GatewayProfilesFile = {
    active: 'b',
    gateways: { a: { url: 'ws://gw:7801' }, b: { url: 'WS://GW:7801/' } },
  };
  assert.equal(profileForUrl('ws://gw:7801', profiles)?.name, 'b');
  assert.equal(profileForUrl('ws://gw:7801', { gateways: profiles.gateways })?.name, 'a');
  assert.equal(profileForUrl('ws://gw:7802', profiles), undefined);
  assert.equal(profileForUrl('not a url', profiles), undefined);
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

test('loadProfiles rejects null/array gateways shapes', () => {
  const path = tmpStore();
  writeFileSync(path, JSON.stringify({ gateways: null }));
  assert.throws(() => loadProfiles(path), /Invalid gateway profiles file/);
  writeFileSync(path, JSON.stringify({ gateways: [] }));
  assert.throws(() => loadProfiles(path), /Invalid gateway profiles file/);
  writeFileSync(path, 'garbage{');
  assert.throws(() => loadProfiles(path), /Invalid gateway profiles file: .*gateways\.json/);
});

test('loadProfiles errors name the file and profile, never the stored secret', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'fs-gw-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'gateways.json');
  const secret = 'fs_fake_secret_7f3a9c';
  // Node's SyntaxError quotes ~10 chars around the error, so check a fragment.
  const leaks = (err: Error): boolean => err.message.includes(secret.slice(0, 7));
  writeFileSync(
    path,
    `{"gateways":{"lab":{"url":"ws://l","authMode":"token","secret":${secret}}}}`,
  );
  assert.throws(
    () => loadProfiles(path),
    (err: Error) => err.message.includes(path) && /not valid JSON/.test(err.message) && !leaks(err),
  );
  for (const lab of [
    { url: 42, secret },
    { url: 'ws://l', secret: { value: secret } },
  ]) {
    writeFileSync(path, JSON.stringify({ gateways: { lab } }));
    assert.throws(
      () => loadProfiles(path),
      (err: Error) =>
        err.message.includes(path) && err.message.includes("profile 'lab'") && !leaks(err),
    );
  }
});
