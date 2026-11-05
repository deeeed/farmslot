import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import { type Call, driveRun } from '../../../../scripts/runner-validation/canary/run-driver.mjs';

import { makeRun } from './test-fixtures.js';

test(
  'event-driven canary settlement keeps changes during reads and unsubscribes',
  { timeout: 1000 },
  async (t) => {
    const dir = await mkdtemp('/tmp/f416-driver-');
    t.after(() => rm(dir, { recursive: true, force: true }));
    const run = makeRun({ id: 'canary', status: 'done', steps: [], decisions: [] });
    let notify: (() => void) | undefined;
    let reads = 0;
    let unsubscribed = false;
    const call: Call = async <T>(method: string) => {
      if (method === 'run.create' || method === 'run.get') return { run } as T;
      assert.equal(method, 'fleet.status');
      const lifecycle = ++reads === 1 ? 'held' : 'ready';
      // The event arrives before the driver awaits it. It must read again, not lose the wakeup.
      queueMicrotask(() => notify?.());
      return { fleet: { slots: [{ slot: 'canary-1', lifecycle }] } } as T;
    };
    const result = await driveRun({
      call,
      dir: path.join(dir, 'evidence'),
      label: 'event settlement',
      slotId: 'canary-1',
      log: async () => {},
      shape: { project: 'canary', create: () => ({}), decide: () => undefined, timeoutMs: 800 },
      hooks: {
        onChange: (listener) => {
          notify = listener;
          return () => {
            notify = undefined;
            unsubscribed = true;
          };
        },
      },
    });
    assert.equal(result.outcome.slot, 'ready/-');
    assert.equal(reads, 2);
    assert.equal(unsubscribed, true);
  },
);
