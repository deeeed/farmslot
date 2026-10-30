import assert from 'node:assert/strict';
import test from 'node:test';

import type { GatewayUpdateStatus } from '@farmslot/protocol';

import {
  GATEWAY_UPDATE_ERROR_TTL_MS,
  GATEWAY_UPDATE_LEGACY_INTEREST_MS,
  GATEWAY_UPDATE_SUCCESS_TTL_MS,
  GatewayUpdateObservation,
} from './gateway-update-observation.js';

const status = (overrides: Partial<GatewayUpdateStatus> = {}): GatewayUpdateStatus => ({
  updateAvailable: true,
  commitsBehind: 2,
  commitsAhead: 0,
  branch: 'main',
  localSha: 'aaaaaaa',
  remoteSha: 'bbbbbbb',
  lastChecked: new Date(1000).toISOString(),
  updateCommand: 'farmslot update',
  error: null,
  ...overrides,
});

test('cold viewers share one observation and warm reads never resample or renew its age', async () => {
  let finish!: (value: GatewayUpdateStatus) => void;
  let samples = 0;
  let now = 1000;
  const owner = new GatewayUpdateObservation({
    sample: () => {
      samples++;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
    hasInterest: () => true,
    changed: () => {},
    empty: status,
    now: () => now,
  });
  const reads = [owner.read(), owner.read()];
  assert.equal(samples, 1);
  finish(status());
  await Promise.all(reads);
  now += GATEWAY_UPDATE_SUCCESS_TTL_MS;
  await owner.read();
  assert.equal(samples, 1);
  assert.deepEqual(owner.observation, { status: 'stale', observedAt: 1000 });
});

test('only admitted interest schedules passive checks, respecting success and error cadence', async () => {
  let interested = false;
  let samples = 0;
  let now = 1000;
  let fail = false;
  const owner = new GatewayUpdateObservation({
    sample: async () => {
      samples++;
      return status(fail ? { error: 'offline' } : {});
    },
    hasInterest: () => interested,
    changed: () => {},
    empty: status,
    now: () => now,
  });
  await owner.tick();
  assert.equal(samples, 0);
  interested = true;
  await owner.tick();
  assert.equal(samples, 1);
  now += GATEWAY_UPDATE_SUCCESS_TTL_MS - 1;
  await owner.tick();
  assert.equal(samples, 1);
  fail = true;
  now++;
  await owner.tick();
  assert.equal(samples, 2);
  assert.equal(owner.snapshot().commitsBehind, 2);
  assert.equal(owner.snapshot().remoteSha, 'bbbbbbb');
  assert.equal(owner.snapshot().lastChecked, new Date(1000).toISOString());
  assert.deepEqual(owner.observation, {
    status: 'stale',
    observedAt: 1000,
    error: { code: 'GATEWAY_UPDATE_SOURCE_UNAVAILABLE', message: 'offline' },
  });
  now += GATEWAY_UPDATE_ERROR_TTL_MS - 1;
  await owner.tick();
  assert.equal(samples, 2);
  now++;
  fail = false;
  interested = false;
  await owner.tick();
  assert.equal(samples, 2);
  interested = true;
  await owner.tick();
  assert.equal(samples, 3);
  assert.deepEqual(owner.observation, { status: 'ready', observedAt: now });
});

test('a due check publishes its result once, without a stale notice while it runs', async () => {
  let now = 1000;
  let finish!: (value: GatewayUpdateStatus) => void;
  const published: string[] = [];
  const owner: GatewayUpdateObservation = new GatewayUpdateObservation({
    sample: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    hasInterest: () => true,
    changed: () => published.push(owner.observation.status),
    empty: status,
    now: () => now,
  });
  const cold = owner.tick();
  finish(status());
  await cold;
  assert.deepEqual(published, ['ready']);
  now += GATEWAY_UPDATE_SUCCESS_TTL_MS;
  const due = owner.tick();
  assert.deepEqual(published, ['ready'], 'no stale notice while the source check runs');
  finish(status());
  await due;
  assert.deepEqual(published, ['ready', 'ready']);
  assert.deepEqual(owner.observation, { status: 'ready', observedAt: now });
});

test('cold source failures report error without manufacturing a successful observation', async () => {
  const owner = new GatewayUpdateObservation({
    sample: async () => {
      throw new Error('offline');
    },
    hasInterest: () => true,
    changed: () => {},
    empty: () => status({ updateAvailable: false, remoteSha: null, lastChecked: null }),
  });
  await owner.read();
  assert.equal(owner.snapshot().lastChecked, null);
  assert.deepEqual(owner.observation, {
    status: 'error',
    error: { code: 'GATEWAY_UPDATE_SOURCE_UNAVAILABLE', message: 'offline' },
  });
});

test('owning installed-state changes publish without a remote check or a new source success time', async () => {
  let samples = 0;
  let notices = 0;
  const owner = new GatewayUpdateObservation({
    sample: async () => {
      samples++;
      return status();
    },
    hasInterest: () => false,
    changed: () => {
      notices++;
    },
    empty: status,
    now: () => 1000,
  });
  await owner.read();
  const before = notices;
  owner.installedChanged({ localSha: 'bbbbbbb', commitsBehind: 0, updateAvailable: false });
  assert.equal(notices, before + 1);
  assert.equal(samples, 1);
  assert.equal(owner.snapshot().localSha, 'bbbbbbb');
  assert.equal(owner.observation.observedAt, 1000);
  owner.installedChanged({ localSha: 'bbbbbbb', commitsBehind: 0, updateAvailable: false });
  assert.equal(notices, before + 1);
});

test('legacy-only reads retain the source TTL and share one due refresh', async () => {
  let now = 1000;
  let samples = 0;
  const owner = new GatewayUpdateObservation({
    sample: async () => {
      samples++;
      return status();
    },
    hasInterest: () => false,
    changed: () => {},
    empty: status,
    now: () => now,
  });
  const legacy = { legacyClientId: 'old-browser', legacyInterest: true };
  await owner.read(false, legacy);
  now += GATEWAY_UPDATE_SUCCESS_TTL_MS - 1;
  await owner.read(false, legacy);
  assert.equal(samples, 1);
  assert.equal(owner.observation.observedAt, 1000);
  now++;
  await Promise.all([owner.read(false, legacy), owner.read(false, legacy)]);
  assert.equal(samples, 2);
  assert.equal(owner.observation.observedAt, now);
});

test('legacy source failures retain success age and retry only after the error deadline', async () => {
  let now = 1000;
  let samples = 0;
  let failed = false;
  const owner = new GatewayUpdateObservation({
    sample: async () => {
      samples++;
      return status(failed ? { error: 'offline' } : {});
    },
    hasInterest: () => false,
    changed: () => {},
    empty: status,
    now: () => now,
  });
  const legacy = { legacyClientId: 'old-browser', legacyInterest: true };
  await owner.read(false, legacy);
  now += GATEWAY_UPDATE_SUCCESS_TTL_MS;
  failed = true;
  await owner.read(false, legacy);
  assert.equal(samples, 2);
  assert.equal(owner.observation.observedAt, 1000);
  assert.equal(owner.snapshot().remoteSha, 'bbbbbbb');
  now += GATEWAY_UPDATE_ERROR_TTL_MS - 1;
  await owner.read(false, legacy);
  assert.equal(samples, 2);
  now++;
  failed = false;
  await owner.read(false, legacy);
  assert.equal(samples, 3);
  assert.deepEqual(owner.observation, { status: 'ready', observedAt: now });
});

test('temporary legacy service interest expires and managed reads never extend it', async () => {
  let now = 1000;
  let samples = 0;
  const owner = new GatewayUpdateObservation({
    sample: async () => {
      samples++;
      return status({ error: 'offline' });
    },
    hasInterest: () => false,
    changed: () => {},
    empty: status,
    now: () => now,
  });
  await owner.read(false, { legacyClientId: 'old-browser', legacyInterest: true });
  now += GATEWAY_UPDATE_ERROR_TTL_MS;
  await owner.tick();
  assert.equal(samples, 2, 'A recent legacy reader keeps the source service active');
  now = 1000 + GATEWAY_UPDATE_LEGACY_INTEREST_MS - 1;
  await owner.read(false, { legacyClientId: 'managed-browser', legacyInterest: false });
  assert.equal(samples, 2);
  now++;
  await owner.tick();
  assert.equal(samples, 2, 'A managed read cannot renew expired legacy interest');
});

test('adoption and disconnect remove only their own legacy source interest', async () => {
  let now = 1000;
  let samples = 0;
  const owner = new GatewayUpdateObservation({
    sample: async () => {
      samples++;
      return status({ error: 'offline' });
    },
    hasInterest: () => false,
    changed: () => {},
    empty: status,
    now: () => now,
  });
  await owner.read(false, { legacyClientId: 'one', legacyInterest: true });
  await owner.read(false, { legacyClientId: 'two', legacyInterest: true });
  owner.forgetLegacyClientInterest('one');
  now += GATEWAY_UPDATE_ERROR_TTL_MS;
  await owner.tick();
  assert.equal(samples, 2, 'Another old viewer retains its own interest');
  await owner.read(false, { legacyClientId: 'two', legacyInterest: false });
  now += GATEWAY_UPDATE_ERROR_TTL_MS;
  await owner.tick();
  assert.equal(samples, 2, 'Adopting observer admission removes the remaining legacy interest');
  await owner.read(false, { legacyClientId: 'three', legacyInterest: true });
  assert.equal(samples, 3);
  owner.forgetLegacyClientInterest('three');
  now += GATEWAY_UPDATE_ERROR_TTL_MS;
  await owner.tick();
  assert.equal(samples, 3, 'Closing a legacy socket stops its source interest');
});

test('async stop drains an in-flight remote check and prevents publication or new work', async () => {
  let finish!: (value: GatewayUpdateStatus) => void;
  let samples = 0;
  let notices = 0;
  const owner = new GatewayUpdateObservation({
    sample: () => {
      samples++;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
    hasInterest: () => true,
    changed: () => {
      notices++;
    },
    empty: status,
  });
  const read = owner.read(false, { legacyClientId: 'old-browser', legacyInterest: true });
  let stopped = false;
  const stopping = owner.stop().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  assert.equal(stopped, false, 'Teardown must await the actual remote process deadline/completion');
  await owner.tick();
  await owner.refresh();
  owner.installedChanged({ localSha: 'ccccccc' });
  assert.equal(samples, 1);
  finish(status());
  await Promise.all([read, stopping]);
  assert.equal(stopped, true);
  assert.equal(notices, 0, 'A retired sampler must not publish on completion');
  await owner.read(true, { legacyClientId: 'old-browser', legacyInterest: true });
  await owner.tick();
  assert.equal(samples, 1);
  assert.equal(notices, 0);
});
