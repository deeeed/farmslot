import '../lib/no-inherited-git-location.mjs';

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { setTimeout as delay } from 'node:timers/promises';

import { reviewPolicySatisfied } from '../../../packages/protocol/src/runs/review-policy.js';
import { REQUESTED_REVIEW_SOURCE } from '../../../services/gateway/src/quality/review-sources.js';
import { loadSlotVars } from '../../../services/gateway/src/core/config.js';
import { reviewFinalSnapshotMatchesPreparedPackage } from '../../../services/gateway/src/run-engine/gate-policy.js';
import {
  createRun,
  getRun,
  loadAllRuns,
  persistRunNow,
  updateRun,
} from '../../../services/gateway/src/runs/store.js';
const reviewModulePath =
  process.env.FARMSLOT_WARM_PROOF_REVIEW_MODULE ??
  '../../../services/gateway/src/review/review-agent.js';
const { runReviewAgent } = await import(reviewModulePath);
const { resetWarmReviewerSessionsForTest, resolveWarmReviewerSession } =
  await import('../../../services/gateway/src/review/session-mode.js');

const [phase, fixture] = process.argv.slice(2);
assert.ok(fixture);
const vars = await loadSlotVars('warm-proof-slot');
const taskDir = 'tasks/review';
const priorReviewScope = REQUESTED_REVIEW_SOURCE.artifactRefs(1).id;
const currentReviewScope = priorReviewScope;
const mode = phase === 'first' ? 'cold' : 'warm';
let runId: string;
if (phase === 'first') {
  const run = createRun({
    flowType: 'fix-bug',
    project: 'warm-proof',
    ticketOrPr: 'example/warm-proof#1',
    slotId: vars.slotId,
    runner: 'claude',
    model: 'opus',
    safetyTier: 'dangerous',
  });
  runId = run.id;
  updateRun(runId, {
    status: 'human-gating',
    branch: 'proof-change',
    taskFile: path.join(vars.remoteRepo, taskDir, 'TASK.md'),
  });
  await writeFile(path.join(fixture, 'run-id'), runId);
} else {
  await loadAllRuns();
  runId = (await readFile(path.join(fixture, 'run-id'), 'utf8')).trim();
  assert.ok(getRun(runId), 'Fresh gateway process must reload the persisted run');
}
if (process.env.FARMSLOT_WARM_PROOF_GATEWAY === '1') {
  await import('../../../services/gateway/src/index.js');
  const origin = `http://127.0.0.1:${process.env.GATEWAY_PORT}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await fetch(`${origin}/health`).catch((error) => {
      if (error.cause?.code === 'ECONNREFUSED') return null;
      throw error;
    });
    if (response?.ok) break;
    await delay(200);
  }
  const { prepareCompletionPackage } =
    await import('../../../services/gateway/src/run-completion/orchestrator.js');
  const { executeReadyGate } =
    await import('../../../services/gateway/src/run-engine/ready-gate.js');
  const run = getRun(runId)!;
  updateRun(runId, {
    status: 'human-gating',
    steps: run.steps.map((step) => ({
      ...step,
      status: step.name === 'human-gate' ? 'running' : 'done',
    })),
  });
  await prepareCompletionPackage(runId, {
    stampReviews: false,
    reviewPolicy: {
      minimumReviews: 1,
      requestedBy: 'human-gate',
    },
  });
  await writeFile(
    path.join(fixture, 'ready-gateway.json'),
    JSON.stringify({ runId, port: process.env.GATEWAY_PORT, phase }),
  );
  const awaitingDecision = executeReadyGate(runId);
  if (phase !== 'second' || process.env.FARMSLOT_WARM_PROOF_MANUAL_SECOND !== '1') {
    let decision = getRun(runId)!.decisions.find((candidate) => !candidate.resolvedAt);
    while (!decision) {
      await delay(100);
      decision = getRun(runId)!.decisions.find((candidate) => !candidate.resolvedAt);
    }
    const { GatewayClient } = await import('../../../packages/cli/src/gateway-client.js');
    const connection = await new GatewayClient({
      url: `ws://127.0.0.1:${process.env.GATEWAY_PORT}`,
      timeout: 30_000,
      credential: null,
    }).connect();
    try {
      await connection.call('run.resolveDecision', {
        runId,
        decisionId: decision.id,
        actionId: 'request-review',
        selectionData: {
          reviewRequest: {
            runner: 'claude',
            model: 'opus',
            effort: null,
            mode,
            ...(mode === 'warm'
              ? {
                  context: {
                    reviewLineages: [
                      { repository: 'example/warm-proof', prNumber: 1, reviewId: priorReviewScope },
                    ],
                  },
                }
              : {}),
          },
        },
      });
    } finally {
      connection.close();
    }
  }
  const action = await awaitingDecision;
  assert.equal(action, 'request-review');
  const request = getRun(runId)!.decisions.at(-1)!;
  const selection = request.selectionData?.reviewRequest as { mode?: string; effort?: string };
  assert.equal(selection?.mode, mode, 'Review request must preserve the chosen mode');
  assert.equal(selection?.effort, null);
}
const before = getRun(runId)!;
const priorSessionId = await readFile(path.join(fixture, 'prior-session'), 'utf8').catch(
  (error) => {
    if (phase === 'first' && error.code === 'ENOENT') return null;
    throw error;
  },
);
const prior = before.agentContexts?.find(
  (context) => context.role === 'review' && context.reviewId === priorReviewScope,
);
const reviewPromise = runReviewAgent(
  vars,
  'claude',
  'opus',
  taskDir,
  vars.slotId,
  runId,
  120_000,
  1,
  'static-code',
  phase === 'first' ? priorReviewScope : currentReviewScope,
  mode,
  null,
  priorReviewScope,
);
const result = await reviewPromise;
assert.equal(result.verdict, 'pass');
let after = getRun(runId)!;
const context = [...after.agentContexts!]
  .filter((candidate) => candidate.role === 'review' && candidate.reviewId === priorReviewScope)
  .sort((left, right) => (right.startedAt ?? '').localeCompare(left.startedAt ?? ''))[0]!;
assert.ok(context.runnerSessionId);
if (phase === 'first') {
  const checklist = await readFile(
    path.join(vars.remoteRepo, taskDir, 'REVIEW.rev-claude.md'),
    'utf8',
  );
  assert.doesNotMatch(checklist, /This is an incremental continuation/);
  assert.equal(result.mode, 'cold');
  assert.equal(result.session?.continuity, 'fresh');
  assert.equal(
    result.reviewSnapshot?.baseSha,
    execFileSync('git', ['rev-parse', 'main'], { cwd: vars.remoteRepo, encoding: 'utf8' }).trim(),
  );
  updateRun(runId, {
    engineState: {
      publishGate: {
        publicationStatus: 'not_published',
        reviews: [
          {
            id: priorReviewScope,
            source: 'human-gate',
            runner: 'claude',
            model: 'opus',
            reviewerSessionId: context.runnerSessionId,
            effort: null,
            mode,
            session: result.session,
            reviewedHeadSha: result.reviewSnapshot?.headSha,
            loopNumber: 1,
            verdict: 'pass',
            unresolvedCount: 0,
            reviewSnapshot: result.reviewSnapshot,
          },
        ],
      },
    },
  });
  await writeFile(path.join(fixture, 'prior-session'), context.runnerSessionId);
} else {
  assert.equal(
    context.runnerSessionId,
    priorSessionId,
    'Explicit warm publication review must reuse the persisted session after gateway restart',
  );
  assert.equal(context.artifactScope, currentReviewScope);
  assert.equal(context.reviewId, priorReviewScope);
  assert.equal(result.mode, 'warm');
  assert.equal(result.session?.reviewId, priorReviewScope);
  const first = JSON.parse(await readFile(path.join(fixture, 'first.json'), 'utf8'));
  assert.equal(result.reviewSnapshot?.baseSha, first.result.reviewSnapshot.headSha);
  assert.notEqual(result.reviewSnapshot?.baseSha, result.reviewSnapshot?.headSha);
  assert.equal(after.engineState!.publishGate!.publicationStatus, 'not_published');
  assert.ok(prior?.runnerSessionId);
  updateRun(runId, {
    engineState: {
      ...after.engineState,
      publishGate: {
        ...after.engineState!.publishGate!,
        reviews: after.engineState!.publishGate!.reviews!.map((review) =>
          review.id === priorReviewScope
            ? {
                ...review,
                mode,
                session: result.session,
                reviewSnapshot: result.reviewSnapshot,
                reviewedHeadSha: result.reviewSnapshot?.headSha,
                reviewerSessionId: context.runnerSessionId,
              }
            : review,
        ),
      },
    },
  });
  const { prepareCompletionPackage } =
    await import('../../../services/gateway/src/run-completion/orchestrator.js');
  const { prPackage } = await prepareCompletionPackage(runId, { stampReviews: false });
  const review = getRun(runId)!.engineState!.publishGate!.reviews!.find(
    (candidate) => candidate.id === priorReviewScope,
  )!;
  assert.equal(
    result.session?.lastReviewedHeadSha,
    first.result.reviewSnapshot.headSha,
    'WARM result provenance keeps the previous reviewed head',
  );
  assert.equal(
    reviewFinalSnapshotMatchesPreparedPackage(review, prPackage),
    true,
    'The real WARM delta must certify the refreshed full PR package',
  );
}
after = getRun(runId)!;
// Exercise the same verified session as standalone result provenance, with no publication rows
// or in-memory registration. IDs, captured head and session evidence come from the real review.
const standalone = {
  ...after,
  flowType: 'review-pr' as const,
  decisions: [],
  engineState: { ...after.engineState!, publishGate: undefined },
  reviewResult: {
    recommendation: 'approve',
    reviewMd: result.artifactPaths.find((file: string) => file.endsWith('/review.md')) ?? '',
    lineComments: [],
    reviewSnapshot: result.reviewSnapshot,
    session: result.session,
  },
};
resetWarmReviewerSessionsForTest();
const recoveredPrimary = resolveWarmReviewerSession(
  {
    runId: runId,
    reviewId: priorReviewScope,
    project: after.project,
    ownerPrincipalId: after.nativeOwnerPrincipalId ?? after.createdByPrincipalId ?? null,
    transport: 'tmux',
    taskDir,
    artifactScope: priorReviewScope,
    runner: 'claude',
    model: 'opus',
    effort: null,
    repository: result.session.repository,
    prNumber: result.session.prNumber,
  },
  [standalone],
);
assert.equal(recoveredPrimary?.runnerSessionId, context.runnerSessionId);
assert.equal(recoveredPrimary?.lastReviewedHeadSha, result.reviewSnapshot.headSha);
assert.equal(
  context.runner,
  after.metrics.runner,
  'Runner choice does not alter separate-session review eligibility',
);
assert(
  reviewPolicySatisfied(
    { minimumReviews: 1, requestedBy: 'human-gate' },
    after.engineState!.publishGate!.reviews ?? [],
  ),
);
assert(
  !reviewPolicySatisfied(
    { minimumReviews: 2, requestedBy: 'human-gate' },
    after.engineState!.publishGate!.reviews ?? [],
  ),
  'Rechecks replace one review result',
);
await persistRunNow(after);
await writeFile(
  path.join(fixture, `${phase}.json`),
  JSON.stringify(
    { gatewayPid: process.pid, runId, sessionId: context.runnerSessionId, context, result },
    null,
    2,
  ),
);
// Keep the completed first reviewer available for the WARM phase.
if (phase !== 'first' && context.target?.target)
  execFileSync('tmux', ['kill-window', '-t', context.target.target]);
console.log(
  JSON.stringify({
    phase,
    runId,
    sessionId: context.runnerSessionId,
    verdict: result.verdict,
    gatewayPid: process.pid,
  }),
);
process.exit(0);
