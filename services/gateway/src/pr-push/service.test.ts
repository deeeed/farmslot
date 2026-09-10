import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { PRPushAttention, PRPushRegisterParams } from '@farmslot/protocol';

import type { PRPushProvider, PushResult } from './expo.js';
import { PRPushService } from './service.js';
import { PRPushStore } from './store.js';

const registration: PRPushRegisterParams = {
  installationId: 'phone',
  profileId: 'gateway',
  token: 'ExpoPushToken[testing]',
  platform: 'ios',
  enabled: true,
  sound: true,
};
const attention: PRPushAttention = {
  id: 'rule:one',
  kind: 'rule',
  title: 'example/repo#1',
  body: 'Review required',
  route: '/pr-automation?notificationId=one',
  createdAt: '2026-09-09T00:00:00.000Z',
  current: true,
};
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'pr-push-'));
  const file = join(directory, 'push.json');
  const store = await PRPushStore.load(file);
  let authorized = true;
  let sources = [attention];
  let sent = 0;
  let result: PushResult = { status: 'ticket', id: 'ticket-1' };
  const provider: PRPushProvider = {
    send: async () => {
      sent++;
      return result;
    },
    receipt: async () => ({ status: 'delivered' }),
  };
  const create = (loaded = store) =>
    new PRPushService(
      loaded,
      () => authorized,
      () => sources,
      provider,
    );
  const service = create();
  await service.register('owner', registration);
  return {
    file,
    store,
    service,
    create,
    provider,
    revoke: () => {
      authorized = false;
    },
    sources: (value: PRPushAttention[]) => {
      sources = value;
    },
    result: (value: PushResult) => {
      result = value;
    },
    sent: () => sent,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

test('durable tickets survive restart, receipt delivery is distinct from acknowledgement, and reconnect does not resend', async () => {
  const f = await fixture();
  try {
    const now = Date.now();
    await f.service.tick(now);
    assert.equal(f.sent(), 1);
    assert.equal(f.service.list('owner').deliveries[0].state, 'ticket');
    assert.equal(f.service.attention('owner')[0].acknowledgedAt, undefined);
    const restarted = f.create(await PRPushStore.load(f.file));
    await restarted.tick(now + 60_001);
    assert.equal(restarted.list('owner').deliveries[0].state, 'delivered');
    await restarted.register('owner', {
      ...registration,
      expectedRevision: restarted.list('owner').devices[0].revision,
    });
    await restarted.tick(now + 120_001);
    assert.equal(f.sent(), 1);
    assert(!JSON.stringify(restarted.list('owner')).includes(registration.token));
    await restarted.acknowledge('owner', attention.id);
    assert(restarted.attention('owner')[0].acknowledgedAt);
  } finally {
    await f.cleanup();
  }
});

test('recipient acknowledgement and revocation suppress delivery without losing the source', async () => {
  const f = await fixture();
  try {
    await f.service.acknowledge('owner', attention.id);
    await f.service.tick();
    assert.equal(f.sent(), 0);
    assert.equal(f.service.attention('owner').length, 1);
    await f.service.register('other', {
      ...registration,
      installationId: 'other-phone',
      token: 'ExpoPushToken[other]',
    });
    assert.equal(f.service.attention('other')[0].acknowledgedAt, undefined);
    f.revoke();
    await f.service.tick();
    assert.equal(f.sent(), 0);
    assert.equal(f.service.attention('other').length, 0);
  } finally {
    await f.cleanup();
  }
});

test('confirmed transient rejection retries after backoff, while ambiguous acceptance survives restart without resend', async () => {
  const f = await fixture();
  try {
    const now = Date.now();
    f.result({ status: 'error', message: 'MessageRateExceeded', retryable: true });
    await f.service.tick(now);
    await f.service.tick(now + 1);
    assert.equal(f.sent(), 1);
    f.result({ status: 'error', message: 'Connection closed', retryable: false, uncertain: true });
    await f.service.tick(now + 60_001);
    assert.equal(f.sent(), 2);
    const restarted = f.create(await PRPushStore.load(f.file));
    await restarted.tick(now + 180_001);
    assert.equal(f.sent(), 2);
    assert.equal(restarted.list('owner').deliveries[0].state, 'unknown');
    assert.equal(restarted.attention('owner').length, 1);
  } finally {
    await f.cleanup();
  }
});

test('crash in sending state is not replayed and a removed audience cannot receive queued content', async () => {
  const f = await fixture();
  try {
    const delivery = await f.store.reserve(f.store.snapshot().devices[0], attention.id, Date.now());
    assert(delivery);
    await f.store.update(delivery.id, { state: 'sending', attempts: 1 });
    const restarted = f.create(await PRPushStore.load(f.file));
    await restarted.tick();
    assert.equal(restarted.list('owner').deliveries[0].state, 'unknown');
    assert.equal(f.sent(), 0);
    await f.store.update(delivery.id, { state: 'queued' });
    f.sources([]);
    await f.service.tick();
    assert.equal(f.service.list('owner').deliveries[0].state, 'cancelled');
    assert.equal(f.sent(), 0);
  } finally {
    await f.cleanup();
  }
});

test('invalid old token receipts cannot disable a replacement token, and cross-principal token claims fail', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.service.register('other', registration), /already registered/);
    await f.service.tick();
    await f.service.register('owner', {
      ...registration,
      expectedRevision: f.service.list('owner').devices[0].revision,
      token: 'ExpoPushToken[replacement]',
    });
    f.provider.receipt = async () => ({
      status: 'error',
      message: 'DeviceNotRegistered',
      retryable: false,
      invalidDevice: true,
    });
    await f.service.tick(Date.now() + 60_001);
    assert.equal(f.service.list('owner').devices[0].enabled, true);
    assert.equal(f.service.list('owner').deliveries[0].state, 'queued');
    await f.service.tick(Date.now() + 120_002);
    assert.equal(
      f.sent(),
      2,
      'A replacement token must receive the previously rejected notification',
    );
  } finally {
    await f.cleanup();
  }
});

test('final retryable receipt sends again, while a receipt lookup outage only polls the accepted ticket', async () => {
  const f = await fixture();
  try {
    const now = Date.now();
    await f.service.tick(now);
    f.provider.receipt = async () => ({
      status: 'error',
      message: 'Expo HTTP 503',
      retryable: true,
      receiptLookup: true,
    });
    await f.service.tick(now + 60_001);
    assert.equal(f.service.list('owner').deliveries[0].state, 'ticket');
    assert.equal(f.sent(), 1);
    f.provider.receipt = async () => ({
      status: 'error',
      message: 'MessageRateExceeded',
      retryable: true,
    });
    await f.service.tick(now + 120_002);
    assert.equal(f.service.list('owner').deliveries[0].state, 'retry');
    await f.service.tick(now + 180_003);
    assert.equal(f.sent(), 2);
    assert.equal(f.service.list('owner').deliveries[0].state, 'ticket');
  } finally {
    await f.cleanup();
  }
});

test('replacement tokens retry confirmed undelivered alerts without replaying a delivered source', async () => {
  const f = await fixture();
  try {
    const now = Date.now();
    f.result({
      status: 'error',
      message: 'DeviceNotRegistered',
      retryable: false,
      invalidDevice: true,
    });
    await f.service.tick(now);
    assert.equal(f.service.list('owner').devices[0].enabled, false);
    assert.equal(f.service.list('owner').deliveries[0].state, 'failed');
    await f.service.register('owner', {
      ...registration,
      expectedRevision: f.service.list('owner').devices[0].revision,
      token: 'ExpoPushToken[replacement]',
    });
    f.result({ status: 'ticket', id: 'replacement-ticket' });
    await f.service.tick(now + 1);
    await f.service.tick(now + 60_002);
    assert.equal(f.sent(), 2);
    assert.equal(f.service.list('owner').deliveries[0].state, 'delivered');
    await f.service.register('owner', {
      ...registration,
      expectedRevision: f.service.list('owner').devices[0].revision,
      token: 'ExpoPushToken[third]',
    });
    await f.service.tick(now + 120_003);
    assert.equal(f.sent(), 2);
  } finally {
    await f.cleanup();
  }
});

test('late background token registration cannot undo an explicit device opt-out', async () => {
  const f = await fixture();
  try {
    const revision = f.service.list('owner').devices[0].revision;
    await f.service.unregister('owner', registration.installationId);
    await assert.rejects(
      f.service.register('owner', { ...registration, expectedRevision: revision }),
      /settings changed/,
    );
    assert.equal(f.service.list('owner').devices[0].enabled, false);
    await f.service.tick();
    assert.equal(f.sent(), 0);
  } finally {
    await f.cleanup();
  }
});

test('a replacement registration persisting concurrently with an invalid-token receipt preserves retry', async () => {
  const f = await fixture();
  try {
    const now = Date.now();
    await f.service.tick(now);
    let registrationWrite: Promise<unknown> | undefined;
    f.provider.receipt = async () => {
      registrationWrite = f.service.register('owner', {
        ...registration,
        expectedRevision: f.service.list('owner').devices[0].revision,
        token: 'ExpoPushToken[concurrent-replacement]',
      });
      return {
        status: 'error',
        message: 'DeviceNotRegistered',
        retryable: false,
        invalidDevice: true,
      };
    };
    await f.service.tick(now + 60_001);
    await registrationWrite;
    assert.equal(f.service.list('owner').devices[0].enabled, true);
    assert.equal(f.service.list('owner').deliveries[0].state, 'queued');
    await f.service.tick(now + 120_002);
    assert.equal(f.sent(), 2);
  } finally {
    await f.cleanup();
  }
});

test('an unsent notification resumes after temporary source ineligibility without replaying accepted tickets', async () => {
  const f = await fixture();
  try {
    const now = Date.now();
    await f.store.reserve(f.store.snapshot().devices[0], attention.id, now);
    f.sources([{ ...attention, current: false }]);
    await f.service.tick(now);
    assert.equal(f.service.list('owner').deliveries[0].state, 'cancelled');
    f.sources([attention]);
    await f.service.tick(now + 1);
    assert.equal(f.sent(), 1, 'Unsent attention must remain deliverable after source recovery');
    f.sources([{ ...attention, current: false }]);
    await f.service.tick(now + 2);
    f.sources([attention]);
    await f.service.tick(now + 3);
    assert.equal(f.sent(), 1, 'A prior accepted ticket must never be replayed after recovery');
  } finally {
    await f.cleanup();
  }
});

test('malformed platform values cannot corrupt the persisted registration', async () => {
  const f = await fixture();
  try {
    const value = {
      ...registration,
      expectedRevision: f.service.list('owner').devices[0].revision,
      platform: ['ios'],
    };
    await assert.rejects(
      f.service.register('owner', value as unknown as PRPushRegisterParams),
      /Platform/,
    );
    const restarted = f.create(await PRPushStore.load(f.file));
    assert.equal(restarted.list('owner').devices[0].platform, 'ios');
  } finally {
    await f.cleanup();
  }
});
