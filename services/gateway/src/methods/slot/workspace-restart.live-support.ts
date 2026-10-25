// Fresh-process startup reconciliation for the disposable workspace recovery proof.
import assert from 'node:assert/strict';
import { readFile, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = await realpath(process.env.FARMSLOT_ROOT ?? '');
assert.ok(root.startsWith(path.join(await realpath(os.tmpdir()), 'workspace-recovery-')));
process.env.NODE_TEST_CONTEXT = '1';
await import('../../runtime/mock-pty.test-support.js');
const { recoverActiveRuns, startOrphanReconciler } =
  await import('../../run-engine/orchestrator.js');
await recoverActiveRuns();
// An idle gateway reconciles orphaned slots on its normal timer after startup.
startOrphanReconciler();
const deadline = Date.now() + 90_000;
let row;
for (;;) {
  const status = JSON.parse(await readFile(path.join(root, 'status.json'), 'utf8'));
  row = status.slots.find((slot: { slot: string }) => slot.slot === 'proof-slot');
  if (row?.lifecycle === 'held') break;
  assert.ok(Date.now() < deadline, 'Startup orphan reconciliation did not settle');
  await new Promise((resolve) => setTimeout(resolve, 100));
}
assert.equal(row.lifecycle, 'held');
assert.equal(row.phase, 'occupied');
assert.equal(row.workspace_recovery.phase, 'fixtures');
console.log('FRESH_PROCESS_RECOVERY_HELD');
