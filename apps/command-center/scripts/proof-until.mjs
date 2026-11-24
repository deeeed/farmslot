import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

/** Collects uncaught page errors on the proof's emulation connection until `stop`. */
export async function watchPageErrors({ emulation, browserCall }) {
  const errors = [];
  const listener = (raw) => {
    const event = JSON.parse(String(raw));
    if (event.method === 'Runtime.exceptionThrown') errors.push(event.params);
  };
  emulation.on('message', listener);
  await browserCall('Runtime.enable');
  return { errors, stop: () => emulation.off('message', listener) };
}

/**
 * Polls a page probe until `accept` holds. A page error fails at once with its message; a timeout
 * saves the last observation under `timeout-<label>`.
 */
export function probeUntil({ inspect, save, errors, prefix = '' }) {
  return async function until(accept, label, timeout = 45_000) {
    const end = Date.now() + timeout;
    let value;
    do {
      value = await inspect();
      if (errors.length) {
        await save(prefix + 'runtime-errors', errors);
        assert.fail(errors[0].exceptionDetails.exception?.description ?? 'Rendering failed');
      }
      if (accept(value)) return value;
      await delay(100);
    } while (Date.now() < end);
    await save(prefix + 'timeout-' + label, value);
    await save(prefix + 'runtime-errors', errors);
    assert.fail(label + ': ' + JSON.stringify(value));
  };
}
