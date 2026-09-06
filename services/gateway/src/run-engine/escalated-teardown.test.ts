import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * The escalated branch: this run merely held the slot's reservation and the
 * RECORDED owner is dead, so the reset also owns physical worker teardown. If
 * that kill fails the slot must stay fenced — a dispatchable row hiding a live
 * worker is the worse outcome — but the caller has to hear about it, which is
 * what returning quietly denied it.
 *
 * Driven in a subprocess against an isolated status file, because the module
 * resolves its path once at load and the real one is the operator's fleet.
 */
async function runAgainstStatusFile(statusPath: string, script: string) {
  const gatewayRoot = path.resolve(import.meta.dirname, '..', '..');
  return execFileAsync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: gatewayRoot,
    env: { ...process.env, NODE_TEST_CONTEXT: '1', FARMSLOT_TEST_STATUS_FILE: statusPath },
  });
}

function statusFileWith(t: test.TestContext, slot: Record<string, unknown>): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'farmslot-escalated-'));
  const statusPath = path.join(dir, 'farm-status.json');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(statusPath, JSON.stringify({ slots: [slot] }));
  return statusPath;
}

test('a failed escalated worker kill leaves the fence up AND reports the failure', async (t) => {
  const statusPath = statusFileWith(t, {
    slot: 'escalated-slot',
    lifecycle: 'busy',
    phase: 'working',
    // A recorded owner this process knows nothing about: the reservation holder
    // cleaning up is not the recorded owner, which is what escalates.
    current_run_id: 'ghost-owner',
    handoff_run_id: 'reservation-holder',
  });

  const { stdout } = await runAgainstStatusFile(
    statusPath,
    `const { cleanupSlotAfterRunFailure } = await import('./src/run-engine/orchestrator.js');
     let threw = '';
     try {
       await cleanupSlotAfterRunFailure(
         'escalated-slot',
         'reservation-holder',
         'test failure',
         undefined,
         async () => { throw new Error('kill refused'); },
       );
     } catch (error) { threw = error.message; }
     console.log(JSON.stringify({ threw }));`,
  );

  const { threw } = JSON.parse(stdout.trim().split('\n').at(-1)!);
  assert.match(threw, /worker kill failed for escalated-slot/, 'the caller must hear about it');
  assert.match(threw, /kill refused/);

  const row = JSON.parse(readFileSync(statusPath, 'utf8')).slots[0];
  assert.equal(row.phase, 'releasing', 'the fence stays up rather than hiding a live worker');
  assert.notEqual(row.lifecycle, 'ready');
});
