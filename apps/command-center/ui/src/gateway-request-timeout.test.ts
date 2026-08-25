import assert from 'node:assert/strict';
import test from 'node:test';

import { Events, FILE_TRANSFER_IDLE_TIMEOUT_MS } from '@farmslot/protocol';

import {
  createIdleRequestTimeout,
  normalizeGatewayRequestOptions,
  transferBoundRequestOptions,
  transferProgressExtendsRequest,
} from './gateway-request-timeout.js';

interface FakeTimer {
  due: number;
  fn: () => void;
  cleared: boolean;
}

test('idle request timeout fires once after the idle window', () => {
  let now = 0;
  const timers: FakeTimer[] = [];
  let fired = 0;
  const handle = createIdleRequestTimeout({
    timeoutMs: 15_000,
    onTimeout: () => {
      fired += 1;
    },
    setTimer: (fn, ms) => {
      const timer: FakeTimer = { due: now + ms, fn, cleared: false };
      timers.push(timer);
      return timer as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (id) => {
      (id as unknown as FakeTimer).cleared = true;
    },
  });

  now = 14_999;
  for (const timer of timers) {
    if (!timer.cleared && timer.due <= now) timer.fn();
  }
  assert.equal(fired, 0);

  now = 15_000;
  for (const timer of timers) {
    if (!timer.cleared && timer.due <= now) timer.fn();
  }
  assert.equal(fired, 1);
  handle.clear();
});

test('extend restarts the idle window so in-flight transfers do not time out', () => {
  let now = 0;
  const timers: FakeTimer[] = [];
  let fired = 0;
  const handle = createIdleRequestTimeout({
    timeoutMs: 15_000,
    onTimeout: () => {
      fired += 1;
    },
    setTimer: (fn, ms) => {
      const timer: FakeTimer = { due: now + ms, fn, cleared: false };
      timers.push(timer);
      return timer as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (id) => {
      (id as unknown as FakeTimer).cleared = true;
    },
  });

  now = 14_000;
  handle.extend();
  now = 15_000;
  for (const timer of timers) {
    if (!timer.cleared && timer.due <= now) timer.fn();
  }
  assert.equal(fired, 0);

  now = 29_000;
  for (const timer of timers) {
    if (!timer.cleared && timer.due <= now) timer.fn();
  }
  assert.equal(fired, 1);
  handle.clear();
});

test('clear prevents a later timeout', () => {
  let now = 0;
  const timers: FakeTimer[] = [];
  let fired = 0;
  const handle = createIdleRequestTimeout({
    timeoutMs: 5,
    onTimeout: () => {
      fired += 1;
    },
    setTimer: (fn, ms) => {
      const timer: FakeTimer = { due: now + ms, fn, cleared: false };
      timers.push(timer);
      return timer as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (id) => {
      (id as unknown as FakeTimer).cleared = true;
    },
  });
  handle.clear();
  handle.extend();

  now = 5;
  for (const timer of timers) {
    if (!timer.cleared && timer.due <= now) timer.fn();
  }
  assert.equal(fired, 0);
});

test('transfer progress extends only the matching in-flight run', () => {
  assert.equal(transferProgressExtendsRequest('run-1', { runId: 'run-1', state: 'running' }), true);
  assert.equal(
    transferProgressExtendsRequest('run-1', { runId: 'run-2', state: 'running' }),
    false,
  );
  assert.equal(transferProgressExtendsRequest('run-1', { runId: 'run-1', state: 'done' }), false);
  assert.equal(transferProgressExtendsRequest('run-1', null), false);
});

test('transfer-bound request options use the protocol idle window and progress event', () => {
  const options = transferBoundRequestOptions('run-9');
  assert.equal(options.timeout, FILE_TRANSFER_IDLE_TIMEOUT_MS);
  assert.equal(options.extendOnEvent, Events.FILE_TRANSFER_PROGRESS);
  assert.equal(options.extendWhen?.({ runId: 'run-9', state: 'running' }), true);
  assert.equal(options.extendWhen?.({ runId: 'run-8', state: 'running' }), false);
});

test('normalizeGatewayRequestOptions keeps numeric timeouts for existing callers', () => {
  assert.deepEqual(normalizeGatewayRequestOptions(5_000, 15_000), { timeout: 5_000 });
  assert.equal(normalizeGatewayRequestOptions(undefined, 15_000).timeout, 15_000);
  assert.equal(normalizeGatewayRequestOptions({ extendOnEvent: 'x' }, 15_000).timeout, 15_000);
  assert.equal(normalizeGatewayRequestOptions({ timeout: 1_000 }, 15_000).timeout, 1_000);
});
