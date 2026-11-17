import assert from 'node:assert/strict';
import test from 'node:test';

import { installFakeGateway } from './testing/fake-gateway.js';
import { resolveGatewayWebSocketUrls } from './gateway-url.js';
import {
  CommandCenterPersonSessionStorage,
  retainedImplicitPersonGatewayUrls,
} from './person-session-storage.js';

const auth = {
  refreshToken: `fsr_${'a'.repeat(32)}_${'b'.repeat(43)}`,
  session: {
    id: 'a'.repeat(32),
    principalId: 'person',
    principalGeneration: 0,
    deviceName: 'Browser',
    deviceKind: 'command-center' as const,
    createdAt: '2026-11-16T00:00:00.000Z',
    lastRefreshedAt: '2026-11-16T00:00:00.000Z',
    refreshExpiresAt: '2027-11-16T00:00:00.000Z',
    revokedAt: null,
  },
};

test('dev port discovery retains the existing proxy device login without copying its credential', async (t) => {
  installFakeGateway(t);
  const page = { protocol: 'http:', host: 'localhost:5175' };
  const previous = resolveGatewayWebSocketUrls(undefined, page);
  const current = resolveGatewayWebSocketUrls(undefined, page, null, null, '7801');
  assert.notDeepEqual(previous, current);
  await new CommandCenterPersonSessionStorage(previous).save(auth);
  const selected = retainedImplicitPersonGatewayUrls(current, previous);
  assert.deepEqual(selected, previous);
  assert.deepEqual(await new CommandCenterPersonSessionStorage(selected).load(), auth);
  assert.equal(await new CommandCenterPersonSessionStorage(current).load(), null);
});

test('current device session or ended-login marker takes priority over an older implicit endpoint', async (t) => {
  installFakeGateway(t);
  const current = ['ws://localhost:7801/ws'];
  const previous = ['ws://localhost:5175/ws'];
  await new CommandCenterPersonSessionStorage(previous).save(auth);
  await new CommandCenterPersonSessionStorage(current).save(null);
  assert.deepEqual(retainedImplicitPersonGatewayUrls(current, previous), current);
  assert.equal(await new CommandCenterPersonSessionStorage(current).load(), null);
  const selected = {
    ...auth,
    refreshToken: `fsr_${'c'.repeat(32)}_${'d'.repeat(43)}`,
    session: { ...auth.session, id: 'c'.repeat(32), principalId: 'current-person' },
  };
  await new CommandCenterPersonSessionStorage(current).save(selected);
  assert.deepEqual(retainedImplicitPersonGatewayUrls(current, previous), current);
  assert.deepEqual(await new CommandCenterPersonSessionStorage(current).load(), selected);
});

test('an existing bearer/password selection is not replaced by an older person login', async (t) => {
  installFakeGateway(t);
  const current = ['ws://localhost:7801/ws'];
  const previous = ['ws://localhost:5175/ws'];
  await new CommandCenterPersonSessionStorage(previous).save(auth);
  assert.deepEqual(retainedImplicitPersonGatewayUrls(current, previous, true), current);
});
