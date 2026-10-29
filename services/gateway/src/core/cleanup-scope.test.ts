import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { withCleanupSignal } from './cleanup-scope.js';

// Select the private store BEFORE importing either execution or state modules.
const directory = await mkdtemp(path.join(os.tmpdir(), 'f204-cleanup-scope-'));
const selected = path.join(directory, 'status.json');
const previousContext = process.env.NODE_TEST_CONTEXT;
const previousStatus = process.env.FARMSLOT_TEST_STATUS_FILE;
process.env.NODE_TEST_CONTEXT = '1';
process.env.FARMSLOT_TEST_STATUS_FILE = selected;
after(async () => {
  if (previousContext === undefined) delete process.env.NODE_TEST_CONTEXT;
  else process.env.NODE_TEST_CONTEXT = previousContext;
  if (previousStatus === undefined) delete process.env.FARMSLOT_TEST_STATUS_FILE;
  else process.env.FARMSLOT_TEST_STATUS_FILE = previousStatus;
  await rm(directory, { recursive: true, force: true });
});
await import('../runtime/mock-pty.test-support.js');
const { execFileArgv } = await import('./exec.js');
const { statusFile, updateSlotStatus } = await import('./state.js');
assert.equal(statusFile, selected);

test('an expired cleanup cannot start a late command or overwrite a new slot owner', async () => {
  const controller = new AbortController();
  const reason = new Error('terminal cleanup deadline expired');
  const slot = { slot: 'f204-owned-slot', current_run_id: 'successor', slot_epoch: 2 };
  const bytes = JSON.stringify({ slots: [slot] }) + '\n';
  await writeFile(selected, bytes);
  controller.abort(reason);
  await withCleanupSignal(controller.signal, async () => {
    assert.throws(() => execFileArgv([process.execPath, '-e', 'process.exit(0)']), reason);
    await assert.rejects(updateSlotStatus(slot.slot, { current_run_id: 'old-run' }), reason);
  });
  assert.equal(await readFile(selected, 'utf8'), bytes);
  await updateSlotStatus(slot.slot, { phase: 'working' });
  const stored = JSON.parse(await readFile(selected, 'utf8'));
  assert.equal(stored.slots[0].current_run_id, 'successor');
  assert.equal(stored.slots[0].phase, 'working', 'cancellation does not leak into a new request');
});

test(
  'cleanup cancellation reaches its in-flight command without an explicit per-call signal',
  { timeout: 4000 },
  async (t) => {
    const controller = new AbortController();
    let pid: number | undefined;
    let output = '';
    t.after(() => {
      controller.abort();
      if (!pid) return;
      try {
        process.kill(-pid, 'SIGKILL');
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
      }
    });
    const result = await withCleanupSignal(controller.signal, () =>
      execFileArgv(
        [
          process.execPath,
          '-e',
          "process.on('SIGTERM', () => { process.stdout.write('closed'); process.exit(0); }); process.stdout.write(process.pid + '\\n'); setInterval(() => {}, 50);",
        ],
        {
          closeoutTimeoutMs: 100,
          onOutput(stream, data) {
            if (stream !== 'stdout') return;
            output += data;
            if (!pid && output.includes('\n')) {
              pid = Number(output.split('\n')[0]);
              controller.abort();
            }
          },
        },
      ),
    );
    assert.equal(result.exitCode, 130);
    assert.match(result.stdout, /closed$/);
    assert.ok(pid);
    const stoppedPid = pid;
    assert.throws(() => process.kill(stoppedPid, 0), { code: 'ESRCH' });
  },
);
