import assert from 'node:assert/strict';
import test from 'node:test';

import { ConnectionLivenessController, type ProbeOutcome } from './connection-liveness-controller';

test('foreground probes immediately and schedules a modest interval', async () => {
  const delays: number[] = [];
  let probes = 0;
  let foregrounds = 0;
  const controller = new ConnectionLivenessController({
    probe: async () => {
      probes += 1;
      return { ok: true };
    },
    onForeground: () => {
      foregrounds += 1;
    },
    onProbeError: () => {},
    setTimer: (_callback, delay) => {
      delays.push(delay);
      return 1 as unknown as ReturnType<typeof setTimeout>;
    },
  });

  controller.setAppActive(true);
  await controller.probeNow();

  assert.equal(foregrounds, 1);
  assert.equal(probes, 1);
  assert.deepEqual(delays, [30_000]);
});

test('background cancels the timer and foreground re-proves', async () => {
  const cleared: Array<ReturnType<typeof setTimeout>> = [];
  const scheduled: { callback?: () => void } = {};
  let probes = 0;
  const controller = new ConnectionLivenessController({
    probe: async () => {
      probes += 1;
      return { ok: true };
    },
    onForeground: () => {},
    onProbeError: () => {},
    setTimer: (callback) => {
      scheduled.callback = callback;
      return 7 as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (timer) => cleared.push(timer),
  });

  controller.setAppActive(true);
  await controller.probeNow();
  controller.setAppActive(false);
  assert.equal(cleared.length, 1);

  scheduled.callback?.();
  await Promise.resolve();
  assert.equal(probes, 1, 'a cancelled background timer cannot start another probe');

  controller.setAppActive(true);
  await controller.probeNow();
  assert.equal(probes, 2, 'returning to foreground performs a fresh proof');
});

test('failed probes back off and concurrent manual probes share one request', async () => {
  const pending: { resolve?: (outcome: ProbeOutcome) => void } = {};
  const delays: number[] = [];
  let probes = 0;
  const controller = new ConnectionLivenessController({
    probe: () => {
      probes += 1;
      return new Promise((resolve) => {
        pending.resolve = resolve;
      });
    },
    onForeground: () => {},
    onProbeError: () => {},
    setTimer: (_callback, delay) => {
      delays.push(delay);
      return 1 as unknown as ReturnType<typeof setTimeout>;
    },
  });

  controller.setAppActive(true);
  const first = controller.probeNow();
  const second = controller.probeNow();
  assert.equal(probes, 1);
  pending.resolve?.({ ok: false });
  await Promise.all([first, second]);
  assert.deepEqual(delays, [60_000]);
});

test('an explicit fresh test waits for the current profile probe, then proves again', async () => {
  const pending: Array<(outcome: ProbeOutcome) => void> = [];
  let markSecondProbeStarted: (() => void) | undefined;
  const secondProbeStarted = new Promise<void>((resolve) => {
    markSecondProbeStarted = resolve;
  });
  let probes = 0;
  const controller = new ConnectionLivenessController({
    probe: () => {
      probes += 1;
      if (probes === 2) markSecondProbeStarted?.();
      return new Promise((resolve) => pending.push(resolve));
    },
    onForeground: () => {},
    onProbeError: () => {},
    setTimer: () => 1 as unknown as ReturnType<typeof setTimeout>,
  });

  controller.setAppActive(true);
  const fresh = controller.probeFresh();
  assert.equal(probes, 1);
  pending.shift()?.({ ok: false });
  await secondProbeStarted;
  assert.equal(probes, 2);
  pending.shift()?.({ ok: true });
  assert.deepEqual(await fresh, { ok: true });
});

test('manual fresh probes run while inactive but scheduled probes remain gated', async () => {
  let probes = 0;
  const controller = new ConnectionLivenessController({
    probe: async () => {
      probes += 1;
      return { ok: true };
    },
    onForeground: () => {},
    onProbeError: () => {},
  });

  assert.deepEqual(await controller.probeNow(), { ok: false });
  assert.equal(probes, 0);
  assert.deepEqual(await controller.probeFresh(), { ok: true });
  assert.equal(probes, 1);
});

test('scheduled probe failures are surfaced and resolve without unhandled rejection', async () => {
  const errors: unknown[] = [];
  let scheduled: (() => void) | undefined;
  const controller = new ConnectionLivenessController({
    probe: async () => {
      throw new Error('probe exploded');
    },
    onForeground: () => {},
    onProbeError: (error) => errors.push(error),
    setTimer: (callback) => {
      scheduled = callback;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    },
  });

  controller.setAppActive(true);
  assert.deepEqual(await controller.probeNow(), { ok: false });
  scheduled?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(errors.length, 2);
  assert.match(String(errors[0]), /probe exploded/);
});

test('reset prevents an old profile failure from carrying backoff into the new profile', async () => {
  const pending: Array<(outcome: ProbeOutcome) => void> = [];
  const delays: number[] = [];
  const controller = new ConnectionLivenessController({
    probe: () => new Promise((resolve) => pending.push(resolve)),
    onForeground: () => {},
    onProbeError: () => {},
    setTimer: (_callback, delay) => {
      delays.push(delay);
      return 1 as unknown as ReturnType<typeof setTimeout>;
    },
  });

  controller.setAppActive(true);
  const oldProbe = controller.probeNow();
  controller.reset();
  pending.shift()?.({ ok: false });
  await oldProbe;

  const freshProbe = controller.probeFresh();
  pending.shift()?.({ ok: true });
  await freshProbe;
  assert.deepEqual(delays, [30_000]);
});
