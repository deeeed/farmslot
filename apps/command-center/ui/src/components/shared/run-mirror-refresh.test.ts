import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import { Events, FILE_TRANSFER_IDLE_TIMEOUT_MS, Methods } from '@farmslot/protocol';

import type { GatewayRequestOptions } from '../../gateway-request-timeout.js';

const requests: Array<{ method: string; params: unknown; options: GatewayRequestOptions }> = [];
mock.module('../../gateway-client.js', {
  namedExports: {
    gateway: {
      request: async (method: string, params: unknown, options: GatewayRequestOptions) => {
        requests.push({ method, params, options });
        return { ok: true, copied: 2 };
      },
    },
  },
});
const { refreshRunMirror } = await import('./run-mirror-refresh.js');

// F313: a release no longer copies evidence back, so a refresh may copy a whole changed package.
// A fixed 120 s or 300 s window gave up on 882 MB at 2 MB/s while the copy was still running.
test('a mirror refresh stays open while its own run reports transfer progress', async () => {
  assert.deepEqual(await refreshRunMirror('run-1'), { ok: true, copied: 2 });
  assert.equal(requests.length, 1);
  const [{ method, params, options }] = requests;
  assert.equal(method, Methods.RUN_REFRESH_MIRROR);
  assert.deepEqual(params, { runId: 'run-1' });
  assert.equal(options.timeout, FILE_TRANSFER_IDLE_TIMEOUT_MS);
  assert.equal(options.extendOnEvent, Events.FILE_TRANSFER_PROGRESS);
  assert.equal(options.extendWhen?.({ runId: 'run-1', state: 'running' }), true);
  assert.equal(options.extendWhen?.({ runId: 'run-2', state: 'running' }), false);
});
