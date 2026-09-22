#!/usr/bin/env node
// Read-only proof against a real local reviewer, never a manufactured mark.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const runId = process.env.FARMSLOT_REVIEW_PROOF_RUN_ID;
assert.ok(runId, 'Set FARMSLOT_REVIEW_PROOF_RUN_ID to a live local review');
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
      { cwd: root, encoding: 'utf8' },
    ),
  );
}
const { run } = rpc('run.get', { runId });
assert.equal(run.transport, 'tmux');
assert.equal(run.reviewWorkspace?.executionNodeId, 'local');
assert.equal(run.reviewWorkspace.cleanedAt, undefined, 'Inspect while worker files still exist');
const context = run.agentContexts.find((entry) => entry.id === 'review');
assert.equal(context.status, 'working', 'A terminal alone must not satisfy startup');
const acceptance = context.promptAcceptance;
const signal = existsSync(context.signalFile)
  ? JSON.parse(readFileSync(context.signalFile, 'utf8'))
  : null;
if (acceptance) {
  assert.equal(acceptance.runner, run.metrics.runner);
  assert.equal(acceptance.deliveryStartedAt, context.promptDeliveryStartedAt);
  assert.equal(acceptance.sessionId, context.runnerSessionId);
  assert.equal(acceptance.sessionPath, context.runnerSessionPath);
  assert.ok(acceptance.observedAt >= Date.parse(context.promptDeliveryStartedAt));
} else {
  assert.ok(signal?.attemptId);
  assert.equal(context.signalAttemptId, signal.attemptId);
  assert.ok(Date.parse(signal.timestamp) >= Date.parse(context.attemptStartedAt));
}
const launch = readFileSync(path.join(run.reviewWorkspace.taskPath, '.terminal-start.cjs'), 'utf8');
const binary = process.env.FARMSLOT_REVIEW_EXPECT_BINARY;
if (binary) assert.ok(launch.includes(binary), 'Launch must use the configured machine executable');
assert.ok(launch.includes('untrusted'), 'Review checkout trust must be explicit');
const progress = rpc('task.progress', { slotId: '', runId });
const children = progress.structured.phases
  .flatMap((phase) => phase.steps)
  .flatMap((step) => (step.subtask ? [step.subtask] : []));
const expected = Number(process.env.FARMSLOT_REVIEW_EXPECT_CHILD_STEPS);
if (expected) assert.ok(children.some((child) => child.progress.totalSteps === expected));
const failedId = process.env.FARMSLOT_REVIEW_FAILED_RUN_ID;
if (failedId) {
  const { run: failed } = rpc('run.get', { runId: failedId });
  assert.ok(failed.steps.some((step) => step.detail === 'review-worker-not-started'));
  assert.ok(!failed.agentContexts.some((entry) => entry.status === 'working'));
}
console.log(
  JSON.stringify(
    {
      runId,
      promptAcceptance: acceptance,
      signalAttemptId: signal?.attemptId,
      children: children.map((child) => ({
        id: child.id,
        status: child.status,
        completed: child.progress.completedSteps,
        total: child.progress.totalSteps,
      })),
    },
    null,
    2,
  ),
);
