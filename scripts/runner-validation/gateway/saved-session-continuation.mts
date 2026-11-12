// Read-only protocol proof against the gateway/profile that owns the validation runs.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { RunGetResult, TaskProgressResult } from '@farmslot/protocol';

import { getRunnerDefinition } from '../../../services/gateway/src/runners/registry.js';

const ids = process.env.FARMSLOT_SAVED_SESSION_PROOF_RUN_IDS?.split(',').filter(Boolean);
assert(ids?.length && ids.length >= 2, 'Set FARMSLOT_SAVED_SESSION_PROOF_RUN_IDS');
const output = process.env.FARMSLOT_SAVED_SESSION_PROOF_OUT;
assert(output, 'Set FARMSLOT_SAVED_SESSION_PROOF_OUT');
const root = process.cwd();
function rpc<T>(method: string, params: Record<string, unknown>): T {
  return JSON.parse(
    execFileSync(
      process.execPath,
      [
        path.join(root, 'apps/command-center/scripts/cdp.mjs'),
        'gateway',
        method,
        JSON.stringify(params),
      ],
      { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
    ),
  );
}
const receipts = [];
for (const runId of ids) {
  const { run } = rpc<RunGetResult>('run.get', { runId });
  const trace = run.repeatReviewContext?.session;
  assert(trace?.priorRunId && trace.reviewId && trace.priorSessionId);
  const { run: prior } = rpc<RunGetResult>('run.get', { runId: trace.priorRunId });
  const previous = prior.agentContexts?.find((context) => context.id === 'review');
  const reviewer = run.agentContexts?.find((context) => context.id === 'review');
  assert(previous?.runnerSessionId && reviewer?.promptAcceptance);
  assert.equal(run.transport, 'tmux');
  assert.equal(run.reviewMode, 'warm');
  assert.equal(trace.continuity, 'resumed');
  assert.equal(trace.reviewId, previous.reviewId);
  assert.equal(trace.priorSessionId, previous.runnerSessionId);
  assert.equal(reviewer.runnerSessionId, previous.runnerSessionId);
  assert.equal(reviewer.promptAcceptance.sessionId, previous.runnerSessionId);
  assert.equal(reviewer.runner, previous.runner);
  assert.equal(reviewer.model, previous.model);
  assert.equal(reviewer.effort ?? null, previous.effort ?? null);
  assert.equal(run.nativeOwnerPrincipalId, prior.nativeOwnerPrincipalId);
  assert.equal(run.createdByPrincipalGeneration, prior.createdByPrincipalGeneration);
  assert.equal(run.project, prior.project);
  assert.equal(run.ticketOrPr, prior.ticketOrPr);
  assert.equal(run.reviewWorkspaceSubject?.baseSha, run.repeatReviewContext?.priorReviewedHeadSha);
  assert.equal(trace.lastReviewedHeadSha, run.repeatReviewContext?.priorReviewedHeadSha);
  if (getRunnerDefinition(reviewer.runner).sessionContinuation.terminal?.workspace === 'retained') {
    assert.equal(run.reviewWorkspace?.checkoutPath, prior.reviewWorkspace?.checkoutPath);
    assert.notEqual(run.reviewWorkspace?.taskPath, prior.reviewWorkspace?.taskPath);
    assert.equal(prior.reviewWorkspace?.transferredTo?.runId, run.id);
    assert.equal(run.reviewWorkspace?.continuedFrom?.runId, prior.id);
  }
  for (const name of ['write-task', 'prepare', 'dispatch'])
    assert.equal(run.steps.find((step) => step.name === name)?.status, 'done');
  const progress = rpc<TaskProgressResult>('task.progress', { slotId: '', runId });
  assert(
    progress.structured?.phases.some((phase) =>
      phase.steps.some((step) => step.status === 'running' || step.status === 'done'),
    ),
    'The resumed conversation must execute its new task checklist',
  );
  assert(!run.reviewPublication?.receipt, 'Proof must not publish a review');
  receipts.push({
    runId,
    priorRunId: prior.id,
    runner: reviewer.runner,
    reviewId: trace.reviewId,
    sessionId: reviewer.runnerSessionId,
    acceptance: reviewer.promptAcceptance,
    source: run.reviewWorkspace,
    range: `${run.reviewWorkspaceSubject?.baseSha}..${run.reviewWorkspaceSubject?.headSha}`,
  });
}
assert(
  new Set(receipts.map((receipt) => receipt.runner)).size >= 2,
  'Prove continuation for at least two runner adapters',
);
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, JSON.stringify({ status: 'PASS', receipts }, null, 2) + '\n');
console.log(`Verified ${receipts.length} saved-session continuations through gateway RPC.`);
