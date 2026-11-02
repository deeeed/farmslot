import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import {
  Events,
  FILE_TRANSFER_IDLE_TIMEOUT_MS,
  Methods,
  type SlotStatus,
} from '@farmslot/protocol';

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
const { refreshRunMirror, runMirrorRefreshUnavailableReason } =
  await import('./run-mirror-refresh.js');

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

const run = {
  id: 'run-1',
  slotId: 'slot-a',
  taskFile: '/farm/projects/p/tasks/feat/manual-000154-1031-015947/TASK.md',
  output: { capturedAt: '2026-11-02T03:00:00Z' },
} as const;
const at = (iso: string) => `[${iso}]`;
const slot = (
  fields: Partial<SlotStatus>,
): Pick<SlotStatus, 'slot' | 'lifecycle' | 'phase' | 'currentRunId' | 'taskFile'> => ({
  slot: 'slot-a',
  lifecycle: 'busy',
  phase: 'working',
  currentRunId: 'run-1',
  taskFile: 'feat/manual-000154-1031-015947',
  ...fields,
});

test('a slot that still holds the run, or its held task, leaves Sync artifacts enabled', () => {
  assert.equal(runMirrorRefreshUnavailableReason(run, [slot({})], at), null);
  assert.equal(
    runMirrorRefreshUnavailableReason(
      run,
      [slot({ lifecycle: 'held', phase: 'occupied', currentRunId: null })],
      at,
    ),
    null,
  );
  assert.equal(
    runMirrorRefreshUnavailableReason(run, [], at),
    null,
    'an unknown slot is not refused',
  );
});

// F313: a release deletes the task and copies nothing back, so a sync after it can only fail.
test('a released slot disables Sync artifacts and says when the files were last synced', () => {
  const released = 'Slot released; files were synced at [2026-11-02T03:00:00Z]';
  for (const fields of [
    { lifecycle: 'ready', phase: null, currentRunId: null },
    { phase: 'releasing' },
    { currentRunId: 'run-2', taskFile: 'feat/manual-000170-1102-120000' },
    { lifecycle: 'held', phase: 'occupied', currentRunId: null, taskFile: 'feat/other-task' },
  ] satisfies Partial<SlotStatus>[])
    assert.equal(runMirrorRefreshUnavailableReason(run, [slot(fields)], at), released);
  assert.equal(
    runMirrorRefreshUnavailableReason(
      { ...run, output: undefined },
      [slot({ lifecycle: 'ready', phase: null, currentRunId: null })],
      at,
    ),
    'Slot released; no files were synced',
  );
});
