import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createConnectionStore, validateConnection } from '../src/connection.mjs';

test('connection validation rejects credential URLs and ambiguous authentication', () => {
  assert.deepEqual(validateConnection({ url: 'wss://farm.example/ws', token: 'secret' }), {
    url: 'wss://farm.example/ws',
    token: 'secret',
  });
  for (const value of [
    null,
    [],
    { url: 'https://farm.example' },
    { url: 'ws://user:secret@farm.example/ws' },
    { url: 'ws://farm.example/ws?token=secret' },
    { url: 'ws://farm.example/ws#secret' },
    { url: 'ws://farm.example', token: 42 },
    { url: 'ws://farm.example', token: 'a', password: 'b' },
    { url: 'ws://farm.example', extra: true },
  ]) {
    assert.throws(() => validateConnection(value));
  }
});

test('storage requires encryption, round trips credentials, and restricts the saved file', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'farmslot-connection-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const connection = { url: 'ws://127.0.0.1:7777/ws', password: 'sample-secret' };
  // This unit test checks the storage boundary. Live Electron validation covers safeStorage itself.
  const encoded = Buffer.from('encrypted-test-value');
  const store = createConnectionStore(directory, {
    isEncryptionAvailable: () => true,
    encryptString: (value) => {
      assert.deepEqual(JSON.parse(value), connection);
      return encoded;
    },
    decryptString: (value) => {
      assert.deepEqual(value, encoded);
      return JSON.stringify(connection);
    },
  });
  assert.equal(await store.load(), null);
  await store.save(connection);
  assert.deepEqual(await store.load(), connection);
  const path = join(directory, 'connection.encrypted');
  assert.deepEqual(await readFile(path), encoded);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const unavailable = createConnectionStore(directory, { isEncryptionAvailable: () => false });
  await assert.rejects(unavailable.save(connection), /encryption is unavailable/);
  await assert.rejects(unavailable.load(), /encryption is unavailable/);
  await writeFile(path, 'corrupted');
  await assert.rejects(store.load());
});
