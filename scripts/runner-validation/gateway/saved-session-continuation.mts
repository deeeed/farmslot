// Read-only protocol proof. The external acceptance matrix pins the task's requested lineages.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { isRecord, type RunGetResult, type TaskProgressResult } from '@farmslot/protocol';

import { getRunnerDefinition } from '../../../services/gateway/src/runners/registry.js';

interface ContinuationProofCase {
  runner: 'claude' | 'codex' | 'pi';
  gatewayHome: string;
  gatewayProfile: string;
  gatewayUrl: string;
  runId: string;
  expectedPriorRunId: string;
  expectedReviewId: string;
  expectedSessionId: string;
}
function proofCase(value: unknown): ContinuationProofCase {
  assert(isRecord(value));
  assert(value.runner === 'claude' || value.runner === 'codex' || value.runner === 'pi');
  for (const key of [
    'gatewayHome',
    'gatewayProfile',
    'gatewayUrl',
    'runId',
    'expectedPriorRunId',
    'expectedReviewId',
    'expectedSessionId',
  ])
    assert(typeof value[key] === 'string' && value[key].length > 0, `Missing ${key}`);
  // Narrow each field at the input boundary; no credentials belong in the matrix.
  const {
    runner,
    gatewayHome,
    gatewayProfile,
    gatewayUrl,
    runId,
    expectedPriorRunId,
    expectedReviewId,
    expectedSessionId,
  } = value;
  assert(
    typeof gatewayHome === 'string' &&
      typeof gatewayProfile === 'string' &&
      typeof gatewayUrl === 'string',
  );
  assert(
    typeof runId === 'string' &&
      typeof expectedPriorRunId === 'string' &&
      typeof expectedReviewId === 'string' &&
      typeof expectedSessionId === 'string',
  );
  const url = new URL(gatewayUrl);
  assert(['ws:', 'wss:'].includes(url.protocol) && !url.username && !url.password);
  return {
    runner,
    gatewayHome,
    gatewayProfile,
    gatewayUrl,
    runId,
    expectedPriorRunId,
    expectedReviewId,
    expectedSessionId,
  };
}
const matrixPath = process.env.FARMSLOT_SAVED_SESSION_PROOF_MATRIX;
const output = process.env.FARMSLOT_SAVED_SESSION_PROOF_OUT;
assert(
  matrixPath && output,
  'Set FARMSLOT_SAVED_SESSION_PROOF_MATRIX and FARMSLOT_SAVED_SESSION_PROOF_OUT',
);
const input: unknown = JSON.parse(await readFile(matrixPath, 'utf8'));
assert(Array.isArray(input));
const cases = input.map(proofCase);
assert.deepEqual(
  cases.map((item) => item.runner).sort(),
  ['claude', 'codex', 'pi'],
  'Require every requested runner, exactly once',
);
const root = process.cwd();
function rpc<T>(item: ContinuationProofCase, method: string, params: Record<string, unknown>): T {
  return JSON.parse(
    execFileSync(
      process.execPath,
      [
        path.join(root, 'apps/command-center/scripts/cdp.mjs'),
        'gateway',
        method,
        JSON.stringify(params),
      ],
      {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        env: {
          ...process.env,
          FARMSLOT_HOME: item.gatewayHome,
          FARMSLOT_GATEWAY_PROFILE: item.gatewayProfile,
          FARMSLOT_GATEWAY: item.gatewayUrl,
        },
      },
    ),
  );
}
const receipts = [];
for (const item of cases) {
  const { run } = rpc<RunGetResult>(item, 'run.get', { runId: item.runId });
  const trace = run.repeatReviewContext?.session;
  assert(trace?.priorRunId && trace.reviewId && trace.priorSessionId);
  assert.equal(
    run.repeatReviewContext?.priorRunId,
    item.expectedPriorRunId,
    'Must use the pinned requested lineage',
  );
  const { run: prior } = rpc<RunGetResult>(item, 'run.get', { runId: item.expectedPriorRunId });
  const previous = prior.agentContexts?.find((context) => context.id === 'review');
  const reviewer = run.agentContexts?.find((context) => context.id === 'review');
  assert(previous?.runnerSessionId && reviewer?.promptAcceptance);
  assert.equal(reviewer.runner, item.runner);
  assert.equal(previous.reviewId, item.expectedReviewId);
  assert.equal(previous.runnerSessionId, item.expectedSessionId);
  assert.equal(trace.reviewId, item.expectedReviewId);
  assert.equal(trace.priorSessionId, item.expectedSessionId);
  assert.equal(reviewer.runnerSessionId, item.expectedSessionId);
  assert.equal(reviewer.promptAcceptance.sessionId, item.expectedSessionId);
  assert.equal(run.transport, 'tmux');
  assert.equal(run.reviewMode, 'warm');
  assert.equal(trace.continuity, 'resumed');
  assert.equal(reviewer.runner, previous.runner);
  assert.equal(reviewer.model, previous.model);
  assert.equal(reviewer.effort ?? null, previous.effort ?? null);
  assert.equal(run.nativeOwnerPrincipalId, prior.nativeOwnerPrincipalId);
  assert.equal(run.createdByPrincipalGeneration ?? 0, prior.createdByPrincipalGeneration ?? 0);
  assert.equal(run.project, prior.project);
  assert.equal(run.ticketOrPr, prior.ticketOrPr);
  assert.equal(run.reviewWorkspaceSubject?.baseSha, run.repeatReviewContext?.priorReviewedHeadSha);
  assert.equal(trace.lastReviewedHeadSha, run.repeatReviewContext?.priorReviewedHeadSha);
  if (getRunnerDefinition(reviewer.runner).sessionContinuation.terminal?.workspace === 'retained') {
    assert.equal(run.reviewWorkspace?.checkoutPath, prior.reviewWorkspace?.checkoutPath);
    assert.notEqual(run.reviewWorkspace?.taskPath, prior.reviewWorkspace?.taskPath);
    assert.equal(run.reviewWorkspace?.continuedFrom?.runId, trace.priorRunId);
  }
  for (const name of ['write-task', 'prepare', 'dispatch'])
    assert.equal(run.steps.find((step) => step.name === name)?.status, 'done');
  const progress = rpc<TaskProgressResult>(item, 'task.progress', { slotId: '', runId: run.id });
  assert(
    progress.structured?.phases.some((phase) =>
      phase.steps.some((step) => step.status === 'running' || step.status === 'done'),
    ),
    'The saved conversation must execute the new task',
  );
  assert(!run.reviewPublication?.receipt, 'Proof must not publish');
  receipts.push({
    runId: run.id,
    priorRunId: prior.id,
    runner: item.runner,
    reviewId: trace.reviewId,
    sessionId: reviewer.runnerSessionId,
    acceptance: reviewer.promptAcceptance,
    source: run.reviewWorkspace,
    range: `${run.reviewWorkspaceSubject?.baseSha}..${run.reviewWorkspaceSubject?.headSha}`,
  });
}
await mkdir(path.dirname(output), { recursive: true });
await writeFile(
  output,
  JSON.stringify({ status: 'PASS', matrix: matrixPath, receipts }, null, 2) + '\n',
);
console.log('Verified all three pinned saved-session continuations through their owning gateways.');
