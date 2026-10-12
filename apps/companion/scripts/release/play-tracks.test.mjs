import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createPlayClient, promoteAndVerify, readBuild, snapshotTracks } from './play-tracks.mjs';

const release = (versionCode) => ({
  status: 'completed',
  name: 'test release',
  versionCodes: [String(versionCode)],
});
function fixture() {
  const calls = [];
  let store = { internal: { releases: [release(14)] }, alpha: { releases: [release(13)] } };
  let edits = {};
  let sequence = 0;
  let ignoreCommit = false;
  let loseInternal = false;
  const client = async (method, suffix, body) => {
    calls.push({ method, suffix, body });
    if (method === 'POST' && suffix === '') {
      const id = String(++sequence);
      edits[id] = structuredClone(store);
      return { id };
    }
    const [, id, , track] = suffix.split('/');
    if (method === 'DELETE') {
      delete edits[id];
      return;
    }
    if (suffix.endsWith(':commit')) {
      const editId = suffix.slice(1, -7);
      if (!ignoreCommit) store = edits[editId];
      if (loseInternal) store.internal = { releases: [release(14)] };
      delete edits[editId];
      return {};
    }
    if (method === 'GET') return structuredClone(edits[id][track]);
    assert.equal(method, 'PUT');
    assert.equal(track, 'alpha');
    edits[id][track] = structuredClone(body);
    return body;
  };
  return {
    client,
    calls,
    upload: () => {
      store.internal = { releases: [release(15)] };
    },
    ignoreCommit: () => {
      ignoreCommit = true;
    },
    loseInternal: () => {
      loseInternal = true;
    },
    bumpAlpha: () => {
      store.alpha = { releases: [release(16)] };
    },
  };
}

test('promotes the submitted internal version without a second upload and reads both committed tracks', async () => {
  const f = fixture();
  const snapshot = await snapshotTracks(f.client, { buildId: 'built-id', versionCode: 15 });
  f.upload();
  const result = await promoteAndVerify(f.client, snapshot);
  assert.deepEqual(result, { versionCode: 15, internal: [15], alpha: [15] });
  const writes = f.calls.filter((call) => call.method === 'PUT');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].suffix.split('/').at(-1), 'alpha');
  assert.deepEqual(writes[0].body.releases[0].versionCodes, ['15']);
  assert.ok(!f.calls.some((call) => /production|bundles|apks/.test(call.suffix)));
  assert.equal(
    f.calls.filter((call) => call.method === 'GET' && call.suffix.endsWith('/internal')).length,
    3,
  );
});

test('an already uploaded version fails before any store release write', async () => {
  const f = fixture();
  await assert.rejects(
    snapshotTracks(f.client, { buildId: 'old', versionCode: 14 }),
    /refusing duplicate submission/,
  );
  assert.ok(!f.calls.some((call) => call.method === 'PUT'));
  assert.equal(f.calls.at(-1).method, 'DELETE');
});

test('missing internal submission fails without promoting', async () => {
  const f = fixture();
  const before = await snapshotTracks(f.client, { buildId: 'new', versionCode: 15 });
  await assert.rejects(
    promoteAndVerify(f.client, before),
    /does not contain submitted versionCode/,
  );
  assert.ok(!f.calls.some((call) => call.method === 'PUT'));
  assert.equal(f.calls.at(-1).method, 'DELETE');
});

test('a newer alpha release is preserved', async () => {
  const f = fixture();
  const before = await snapshotTracks(f.client, { buildId: 'new', versionCode: 15 });
  f.upload();
  f.bumpAlpha();
  await assert.rejects(promoteAndVerify(f.client, before), /refusing replacement/);
  assert.ok(!f.calls.some((call) => call.method === 'PUT'));
});

test('readback rejects a commit that did not advance alpha', async () => {
  const f = fixture();
  const before = await snapshotTracks(f.client, { buildId: 'new', versionCode: 15 });
  f.upload();
  f.ignoreCommit();
  await assert.rejects(promoteAndVerify(f.client, before), /alpha did not move/);
});

test('readback rejects internal failing to retain the submitted version', async () => {
  const f = fixture();
  const before = await snapshotTracks(f.client, { buildId: 'new', versionCode: 15 });
  f.upload();
  f.loseInternal();
  await assert.rejects(promoteAndVerify(f.client, before), /internal did not move/);
});

test('build binding rejects preview, unfinished or ambiguous EAS results', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'play-build-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'build.json');
  const build = {
    id: 'bound',
    status: 'FINISHED',
    platform: 'ANDROID',
    buildProfile: 'production',
    distribution: 'STORE',
    appBuildVersion: '15',
  };
  writeFileSync(file, JSON.stringify([build]));
  assert.deepEqual(readBuild(file), { buildId: 'bound', versionCode: 15 });
  for (const candidate of [
    [{ ...build, buildProfile: 'preview' }],
    [{ ...build, status: 'IN_PROGRESS' }],
    [build, build],
  ]) {
    writeFileSync(file, JSON.stringify(candidate));
    assert.throws(() => readBuild(file), /Expected one finished production/);
  }
});

test('existing service account signs an OAuth assertion and credentials stay out of failures', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'play-auth-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const key = path.join(root, 'fixture-key.json');
  writeFileSync(
    key,
    JSON.stringify({
      client_email: 'test@example.invalid',
      private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    }),
    { mode: 0o600 },
  );
  const client = await createPlayClient('net.siteed.farmslot', key, async (url, options) => {
    if (url.includes('oauth2')) {
      const jwt = options.body.get('assertion');
      const [header, payload, signature] = jwt.split('.');
      assert.ok(
        verify(
          'RSA-SHA256',
          Buffer.from(header + '.' + payload),
          publicKey,
          Buffer.from(signature, 'base64url'),
        ),
      );
      assert.equal(
        JSON.parse(Buffer.from(payload, 'base64url')).scope,
        'https://www.googleapis.com/auth/androidpublisher',
      );
      return new Response(JSON.stringify({ access_token: 'fixture-only-token' }));
    }
    assert.equal(options.headers.Authorization, 'Bearer fixture-only-token');
    return new Response('do not echo fixture-only-token', { status: 403 });
  });
  await assert.rejects(
    client('GET', '/edit/tracks/internal'),
    (error) => /HTTP 403/.test(error.message) && !error.message.includes('fixture-only-token'),
  );
});
