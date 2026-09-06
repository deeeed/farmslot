import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * `resetSlot` is the UNGUARDED reset: no phase check and no epoch check, unlike
 * `slotRelease` and `cleanupSlotAfterRunFailure`, which both fence the slot and
 * finish through `resetSlotIf` under their own epoch guard. Publishing a
 * `releasing` slot back to ready from here hands out a slot whose windows are
 * still being killed and whose worktree is still being reset.
 *
 * Driven in a subprocess against an isolated status file, because the module
 * resolves its path once at load and the real one is the operator's fleet.
 */
async function runAgainstStatusFile(
  statusPath: string,
  script: string,
): Promise<{ stdout: string; stderr: string }> {
  const gatewayRoot = path.resolve(import.meta.dirname, '..', '..');
  return execFileAsync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: gatewayRoot,
    env: { ...process.env, NODE_TEST_CONTEXT: '1', FARMSLOT_TEST_STATUS_FILE: statusPath },
  });
}

function statusFileWith(t: test.TestContext, slot: Record<string, unknown>): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'farmslot-reset-fence-'));
  const statusPath = path.join(dir, 'farm-status.json');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(statusPath, JSON.stringify({ slots: [slot] }));
  return statusPath;
}

test('resetSlot leaves a slot that a release already fenced', async (t) => {
  const statusPath = statusFileWith(t, {
    slot: 'fence-slot',
    lifecycle: 'busy',
    phase: 'releasing',
    current_run_id: 'run-releasing',
  });

  await runAgainstStatusFile(
    statusPath,
    `const { resetSlot } = await import('./src/core/state.js');
     await resetSlot('fence-slot', true);`,
  );

  const row = JSON.parse(readFileSync(statusPath, 'utf8')).slots[0];
  assert.equal(row.lifecycle, 'busy', 'a slot mid-release must not be republished as ready');
  assert.equal(row.phase, 'releasing');
  assert.equal(row.current_run_id, 'run-releasing');
});

test('a release that fences between the check and the write is not overwritten', async (t) => {
  // The reason this is ONE conditional update rather than a read then a write.
  // The old shape read `phase` OUTSIDE the store's write chain, found it clear,
  // and then wrote unconditionally — so a release that fenced the slot in that
  // gap had its fence erased and continued tearing down a slot already
  // republished as ready.
  //
  // Driven by starting the reset and landing the fence before awaiting it: the
  // read resolves first either way, and only the conditional write re-checks
  // inside the chain.
  const statusPath = statusFileWith(t, {
    slot: 'fence-slot',
    lifecycle: 'busy',
    phase: 'working',
    current_run_id: 'run-done',
  });

  await runAgainstStatusFile(
    statusPath,
    `const { resetSlot, updateSlotStatus } = await import('./src/core/state.js');
     const reset = resetSlot('fence-slot', true);
     const fence = updateSlotStatus('fence-slot', { lifecycle: 'busy', phase: 'releasing' });
     await Promise.all([reset, fence]);`,
  );

  const row = JSON.parse(readFileSync(statusPath, 'utf8')).slots[0];
  assert.equal(row.phase, 'releasing', 'the rival release keeps its fence');
  assert.equal(row.lifecycle, 'busy');
});

test('resetSlot still resets a slot no release owns', async (t) => {
  // The fence must not turn the reset off: this is the ordinary path every
  // reclaim and cancel depends on.
  const statusPath = statusFileWith(t, {
    slot: 'fence-slot',
    lifecycle: 'busy',
    phase: 'working',
    current_run_id: 'run-done',
  });

  await runAgainstStatusFile(
    statusPath,
    `const { resetSlot } = await import('./src/core/state.js');
     await resetSlot('fence-slot', true);`,
  );

  const row = JSON.parse(readFileSync(statusPath, 'utf8')).slots[0];
  assert.equal(row.lifecycle, 'ready');
  assert.equal(row.current_run_id, null);
});
