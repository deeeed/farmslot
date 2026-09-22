// Read-only production proof of a Pi reviewer starting after the worker finished.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const runId = process.env.FARMSLOT_PI_REVIEW_PROOF_RUN_ID;
assert.ok(runId, 'Set FARMSLOT_PI_REVIEW_PROOF_RUN_ID to the recovered run');
const role = process.argv[2] ?? 'self-review';
assert.ok(['self-review', 'self-review-fix'].includes(role));
function rpc(method, params) {
  return JSON.parse(
    execFileSync(
      process.execPath,
      [
        path.join(root, 'apps/command-center/scripts/cdp.mjs'),
        'gateway',
        method,
        JSON.stringify(params),
      ],
      { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
    ),
  );
}
const { run } = rpc('run.get', { runId });
assert.notEqual(run.status, 'failed', run.error);
const worker = run.steps.find((step) => step.name === 'monitor');
assert.equal(worker.status, 'done');
assert.equal(worker.outputs.workerSignal.outcome, 'success');
const context = run.agentContexts.find((entry) => entry.role === role && entry.runner === 'pi');
assert.ok(context?.signalFile, `${role} must have a scoped signal`);
const signal = JSON.parse(rpc('fs.read', { slotId: run.slotId, path: context.signalFile }).content);
assert.ok(signal.attemptId, `${role} must acknowledge its own attempt`);
// Reviewer startup pins the attempt; fix recovery can bind it at completion.
// In that case the scoped signal must still be newer than this delivery.
if (context.signalAttemptId) assert.equal(signal.attemptId, context.signalAttemptId);
assert.ok(Date.parse(signal.timestamp) >= Date.parse(context.attemptStartedAt));
if (context.promptDeliveryStartedAt) {
  assert.ok(Date.parse(signal.timestamp) >= Date.parse(context.promptDeliveryStartedAt));
}
if (process.argv.includes('--complete')) {
  assert.equal(context.status, 'complete', 'Gateway must settle the completed fix after recovery');
  assert.equal(
    context.signalAttemptId,
    signal.attemptId,
    'Recovery must bind the completed attempt',
  );
  assert.equal(signal.status, 'complete');
}
assert.equal(signal.checklistTiming.source, path.posix.basename(context.taskFile));
assert.ok(signal.checklistTiming.events.length > 0, `${role} must execute checklist steps`);
const progress = rpc('task.progress', { slotId: run.slotId, runId, contextId: context.id });
assert.equal(progress.contextId, context.id);
assert.ok(progress.structured.completedSteps > 0, 'Gateway must expose reviewer progress');
console.log(
  JSON.stringify({
    runId,
    status: run.status,
    contextId: context.id,
    attemptId: signal.attemptId,
    completedSteps: progress.structured.completedSteps,
    totalSteps: progress.structured.totalSteps,
  }),
);
