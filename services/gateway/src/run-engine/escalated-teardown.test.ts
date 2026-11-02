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
async function runAgainstStatusFile(
  statusPath: string,
  script: string,
  env: NodeJS.ProcessEnv = {},
) {
  const gatewayRoot = path.resolve(import.meta.dirname, '..', '..');
  return execFileAsync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: gatewayRoot,
    env: { ...process.env, NODE_TEST_CONTEXT: '1', FARMSLOT_TEST_STATUS_FILE: statusPath, ...env },
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

test('a retained-session handoff hold clears its reservation and never kills the warm worker', async (t) => {
  const statusPath = statusFileWith(t, {
    slot: 'held-slot',
    lifecycle: 'busy',
    phase: 'working',
    // The owner already went terminal (ci-watch chained a successor) but its
    // worker is deliberately warm; the successor blocked rather than replace it.
    current_run_id: 'terminal-owner',
    handoff_run_id: 'reservation-holder',
  });

  const { stdout } = await runAgainstStatusFile(
    statusPath,
    `const { cleanupSlotAfterRunFailure } = await import('./src/run-engine/orchestrator.js');
     let killed = false;
     await cleanupSlotAfterRunFailure(
       'held-slot',
       'reservation-holder',
       'blocked run',
       undefined,
       async () => { killed = true; },
       { preserveRetainedWorker: true },
     );
     console.log(JSON.stringify({ killed }));`,
  );

  const { killed } = JSON.parse(stdout.trim().split('\n').at(-1)!);
  assert.equal(killed, false, 'the worker the dispatch declined to replace stays alive');

  const row = JSON.parse(readFileSync(statusPath, 'utf8')).slots[0];
  assert.equal(row.handoff_run_id, null, 'only the reservation is cleared');
  assert.equal(row.current_run_id, 'terminal-owner');
  assert.equal(row.lifecycle, 'busy', 'the slot is not published ready over a live worker');
});

// A find-slot abort before the claim (F306 app binding) fails a run pinned to a
// slot it never claimed: the slot is idle or another run's, so failure cleanup
// owes it nothing. The failed run is in an isolated run store, so the
// ownership check for a failed run is the one that answers.
for (const [label, row] of [
  ['an idle slot', { lifecycle: 'ready', phase: null, current_run_id: null }],
  [
    'a slot another run holds',
    { lifecycle: 'busy', phase: 'working', current_run_id: 'live-owner' },
  ],
] as const) {
  test(`failure cleanup leaves ${label} that the failed run never claimed untouched`, async (t) => {
    const before = { slot: 'pinned-slot', slot_epoch: 7, ...row };
    const statusPath = statusFileWith(t, before);

    const { stdout } = await runAgainstStatusFile(
      statusPath,
      `const store = await import('./src/runs/store.js');
       const { cleanupSlotAfterRunFailure } = await import('./src/run-engine/orchestrator.js');
       const run = store.createRun({ project: 'fixture', flowType: 'dev', ticketOrPr: 'F306 abort' });
       store.updateRun(run.id, { status: 'failed', slotId: 'pinned-slot' });
       const touched = [];
       await cleanupSlotAfterRunFailure(
         'pinned-slot',
         run.id,
         'find-slot failure',
         async () => { touched.push('destructive cleanup'); },
         async () => { touched.push('worker teardown'); },
       );
       console.log(JSON.stringify({ touched, status: store.getRun(run.id).status }));`,
      { FARMSLOT_RUNS_DIR: path.join(path.dirname(statusPath), 'runs') },
    );

    const { touched, status } = JSON.parse(stdout.trim().split('\n').at(-1)!);
    assert.equal(status, 'failed');
    assert.deepEqual(touched, [], 'no teardown runs for a slot the run never claimed');
    assert.deepEqual(JSON.parse(readFileSync(statusPath, 'utf8')).slots[0], before);
  });
}
