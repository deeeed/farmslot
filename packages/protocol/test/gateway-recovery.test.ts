import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import {
  GATEWAY_CONNECT_DEADLINE_MS,
  GATEWAY_HEARTBEAT_MS,
  GATEWAY_PING_DEADLINE_MS,
  gatewayAuthenticationRefused,
  gatewayOfflineLabel,
  GatewayRecovery,
} from '../src/transport/gateway-recovery.js';

function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const state = {
    enabled: true,
    supported: true,
    connects: 0,
    retires: 0,
    pings: 0,
    responses: [] as Array<{ latencyMs: number; completedAt: number }>,
    answer: async (): Promise<unknown> => ({ ok: true, serverTimeMs: Date.now() }),
  };
  const recovery = new GatewayRecovery({
    enabled: () => state.enabled,
    canProbe: () => state.supported,
    connect: () => {
      state.connects++;
      recovery.update('connecting');
    },
    retire: () => {
      state.retires++;
      recovery.update('disconnected');
    },
    onResponse: (latencyMs, completedAt) => state.responses.push({ latencyMs, completedAt }),
    ping: () => {
      state.pings++;
      return state.answer();
    },
  });
  t.after(() => recovery.dispose());
  return {
    state,
    recovery,
    settle: async () => {
      for (let i = 0; i < 5; i++) await Promise.resolve();
    },
  };
}

test('failed sockets back off to 30 seconds and successful authentication resets the delay', (t) => {
  const { state, recovery } = fixture(t);
  for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
    recovery.update('disconnected');
    const before = state.connects;
    t.mock.timers.tick(delay - 1);
    assert.equal(state.connects, before);
    t.mock.timers.tick(1);
    assert.equal(state.connects, before + 1);
  }
  recovery.update('connected');
  recovery.update('disconnected');
  t.mock.timers.tick(1000);
  assert.equal(state.connects, 8);
});

test('an uncompleted socket/auth handshake is retired and retried', (t) => {
  const { state, recovery } = fixture(t);
  recovery.update('connecting');
  t.mock.timers.tick(GATEWAY_CONNECT_DEADLINE_MS - 1);
  assert.equal(state.retires, 0);
  t.mock.timers.tick(1);
  assert.equal(state.retires, 1);
  t.mock.timers.tick(1000);
  assert.equal(state.connects, 1);
});

test('a silent open socket is pinged and retired after the bounded unanswered probe', async (t) => {
  const { state, recovery, settle } = fixture(t);
  state.answer = () => new Promise(() => {});
  recovery.update('connected');
  t.mock.timers.tick(GATEWAY_HEARTBEAT_MS);
  assert.equal(state.pings, 1);
  recovery.wake();
  assert.equal(state.pings, 1, 'wake events join the in-flight probe');
  t.mock.timers.tick(GATEWAY_PING_DEADLINE_MS);
  await settle();
  assert.equal(state.retires, 1);
  t.mock.timers.tick(1000);
  assert.equal(state.connects, 1);
});

test('focus, visibility and network wakes bypass backoff but coalesce one connection attempt', (t) => {
  const { state, recovery } = fixture(t);
  recovery.update('disconnected');
  recovery.wake();
  recovery.wake();
  recovery.wake();
  assert.equal(state.connects, 1);
  recovery.update('disconnected');
  recovery.wake();
  assert.equal(
    state.connects,
    1,
    'an immediate failure cannot turn duplicate wake events into a spin',
  );
  t.mock.timers.tick(1000);
  recovery.wake();
  assert.equal(state.connects, 2);
});

test('wake pings a healthy socket without replacing it or replaying a command', async (t) => {
  const { state, recovery, settle } = fixture(t);
  recovery.update('connected');
  recovery.wake();
  recovery.wake();
  await settle();
  assert.equal(state.pings, 1);
  assert.equal(state.retires, 0);
  assert.equal(state.connects, 0);
  assert.equal(state.responses.length, 1, 'the shared pong updates existing health diagnostics');
});

test('a late probe from a retired profile cannot close its replacement', async (t) => {
  const { state, recovery, settle } = fixture(t);
  let reject!: (error: Error) => void;
  state.answer = () =>
    new Promise((_resolve, fail) => {
      reject = fail;
    });
  recovery.update('connected');
  recovery.wake();
  recovery.reset();
  recovery.update('connected');
  reject(new Error('Old profile failed'));
  await settle();
  assert.equal(state.retires, 0);
});

test('sign-out, credential refusal, background pause and disposal cancel every recovery path', (t) => {
  const { state, recovery } = fixture(t);
  recovery.update('disconnected');
  state.enabled = false;
  recovery.update('disconnected');
  recovery.wake();
  t.mock.timers.tick(120_000);
  assert.equal(state.connects, 0);
  state.enabled = true;
  recovery.update('connecting');
  recovery.dispose();
  t.mock.timers.tick(120_000);
  recovery.wake();
  assert.equal(state.retires, 0);
  assert.equal(state.connects, 0);
});

test('older gateways without the ping capability do not enter a reconnect loop', (t) => {
  const { state, recovery } = fixture(t);
  state.supported = false;
  recovery.update('connected');
  t.mock.timers.tick(90_000);
  assert.equal(state.pings, 0);
  assert.equal(state.retires, 0);
});

test('only an explicit authentication refusal blocks automatic recovery and offline UI', () => {
  assert.equal(
    gatewayAuthenticationRefused(Object.assign(new Error('late'), { code: 'TIMEOUT' })),
    false,
  );
  assert.equal(gatewayAuthenticationRefused(new Error('Connection closed')), false);
  for (const code of [
    'AUTH_REQUIRED',
    'AUTH_FAILED',
    'AUTH_FORBIDDEN',
    'AUTH_PERSON_SESSION_REQUIRED',
    'AUTH_SESSION_ENDED',
  ])
    assert.equal(gatewayAuthenticationRefused(Object.assign(new Error(code), { code })), true);
  assert.equal(gatewayOfflineLabel('disconnected', true), 'Gateway offline · Reconnecting…');
  assert.equal(gatewayOfflineLabel('connecting', true), 'Gateway offline · Reconnecting…');
  assert.equal(gatewayOfflineLabel('connected', true), undefined);
  assert.equal(gatewayOfflineLabel('auth_required', false), undefined);
});
