import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createNativeConversationStorage,
  nativeConversationStorageKey,
} from './native-conversation-storage';

test('same-profile account changes cannot restore another principal draft or command lock', () => {
  const identity = {
    profile: 'same-profile',
    gatewayUrl: 'ws://localhost:19777',
    principalId: 'a',
    node: 'remote',
    sessionId: 'session',
    runId: 'run',
    contextId: 'context',
    leaseId: 'lease',
  };
  const key = nativeConversationStorageKey(identity);
  for (const field of [
    'profile',
    'gatewayUrl',
    'principalId',
    'node',
    'sessionId',
    'runId',
    'contextId',
    'leaseId',
  ] as const) {
    assert.notEqual(nativeConversationStorageKey({ ...identity, [field]: 'other' }), key, field);
  }
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('a remounted controller restores the latest edit after all earlier writes finish', async () => {
  const first = deferred();
  let saved: string | null = null;
  let count = 0;
  const storage = createNativeConversationStorage({
    getItem: async () => saved,
    setItem: async (_key, value) => {
      if (++count === 1) await first.promise;
      saved = value;
    },
  });
  const earlier = storage.write('profile/session/lease', 'old draft');
  const latest = JSON.stringify({
    draft: 'focused unsent edit',
    pending: { commandId: 'same-command' },
    responses: ['same-approval'],
  });
  const edit = storage.write('profile/session/lease', latest);
  let restored = false;
  const remount = storage.read('profile/session/lease').then((value) => {
    restored = true;
    return value;
  });
  await Promise.resolve();
  assert.equal(restored, false);
  first.resolve();
  await Promise.all([earlier, edit]);
  assert.equal(await remount, latest);
  assert.equal(saved, latest);
});

test('different profile, session and worker lease keys never share writes or wait queues', async () => {
  const blocked = deferred();
  const values = new Map<string, string>();
  const storage = createNativeConversationStorage({
    getItem: async (key) => values.get(key) ?? null,
    setItem: async (key, value) => {
      if (key === 'profile-a/session-a/lease-a') await blocked.promise;
      values.set(key, value);
    },
  });
  const first = storage.write('profile-a/session-a/lease-a', 'private draft');
  for (const key of [
    'profile-b/session-a/lease-a',
    'profile-a/session-b/lease-a',
    'profile-a/session-a/lease-b',
  ]) {
    assert.equal(await storage.read(key), null);
    await storage.write(key, key);
    assert.equal(await storage.read(key), key);
  }
  blocked.resolve();
  await first;
  assert.equal(await storage.read('profile-a/session-a/lease-a'), 'private draft');
});

test('failed writes reach callers and restoring readers, while later edits can retry', async () => {
  const first = deferred();
  let fail = true;
  let saved: string | null = null;
  const storage = createNativeConversationStorage({
    getItem: async () => saved,
    setItem: async (_key, value) => {
      await first.promise;
      if (fail) throw new Error('disk full');
      saved = value;
    },
  });
  const write = assert.rejects(storage.write('session', 'edit'), /disk full/);
  const restore = assert.rejects(storage.read('session'), /disk full/);
  first.resolve();
  await Promise.all([write, restore]);
  fail = false;
  await storage.write('session', 'retry');
  assert.equal(await storage.read('session'), 'retry');
});
