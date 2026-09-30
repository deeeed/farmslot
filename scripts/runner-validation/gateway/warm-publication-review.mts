import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { setTimeout as delay } from 'node:timers/promises';

import { EXTRA_REVIEW_SOURCE } from '../../../services/gateway/src/quality/review-sources.js';
import { loadSlotVars } from '../../../services/gateway/src/core/config.js';
import {
  createRun,
  getRun,
  loadAllRuns,
  persistRunNow,
  updateRun,
} from '../../../services/gateway/src/runs/store.js';
const { runReviewAgent } = await import(
  process.env.FARMSLOT_WARM_PROOF_REVIEW_MODULE ??
    '../../../services/gateway/src/self-review/review-agent.js'
);

const [phase, fixture] = process.argv.slice(2);
assert.ok(fixture);
const vars = await loadSlotVars('warm-proof-slot');
const taskDir = 'tasks/review';
const priorReviewScope = EXTRA_REVIEW_SOURCE.artifactRefs(1).id;
const currentReviewScope = EXTRA_REVIEW_SOURCE.artifactRefs(2).id;
let runId: string;
if (phase === 'first') {
  const run = createRun({
    flowType: 'fix-bug',
    project: 'warm-proof',
    ticketOrPr: 'WARM-PROOF',
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
    reviewDepth: {
      minimumIndependentReviews: 1,
      requireCrossRunner: false,
      extraLoopsRequested: 0,
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
        actionId: 'request-extra-review',
        selectionData: {
          reviewRequest: {
            extraLoopsRequested: 1,
            loops: [
              {
                order: 1,
                runner: 'claude',
                model: 'opus',
                validationDepth: 'static-code',
                sessionIntent: 'resume',
              },
            ],
          },
        },
      });
    } finally {
      connection.close();
    }
  }
  const action = await awaitingDecision;
  assert.equal(action, 'request-extra-review');
  const request = getRun(runId)!.decisions.at(-1)!;
  const loop = (
    request.selectionData?.reviewRequest as { loops?: Array<{ sessionIntent?: string }> }
  )?.loops?.[0];
  assert.equal(loop?.sessionIntent, 'resume', 'Browser must submit the default warm review choice');
}
const before = getRun(runId)!;
const priorSessionId = await readFile(path.join(fixture, 'prior-session'), 'utf8').catch(
  (error) => {
    if (phase === 'first' && error.code === 'ENOENT') return null;
    throw error;
  },
);
const prior = before.agentContexts?.find(
  (context) => context.role === 'self-review' && context.runner === 'claude',
);
const result = await runReviewAgent(
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
  'warm-per-reviewer',
  'resume',
);
assert.equal(result.verdict, 'pass');
const after = getRun(runId)!;
const context = after.agentContexts!.find(
  (candidate) => candidate.role === 'self-review' && candidate.runner === 'claude',
)!;
assert.ok(context.runnerSessionId);
if (phase === 'first') {
  const checklist = await readFile(
    path.join(vars.remoteRepo, taskDir, 'SELF-REVIEW.rev-claude.md'),
    'utf8',
  );
  assert.doesNotMatch(checklist, /This is an incremental continuation/);
  updateRun(runId, {
    engineState: {
      publishGate: {
        publicationStatus: 'not_published',
        independentReviews: [
          {
            id: priorReviewScope,
            source: 'human-gate',
            runner: 'claude',
            model: 'opus',
            reviewerSessionId: context.runnerSessionId,
            crossRunner: false,
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
  assert.equal(after.engineState!.publishGate!.publicationStatus, 'not_published');
  assert.ok(prior?.runnerSessionId);
}
await persistRunNow(getRun(runId)!);
await writeFile(
  path.join(fixture, `${phase}.json`),
  JSON.stringify(
    { gatewayPid: process.pid, runId, sessionId: context.runnerSessionId, context, result },
    null,
    2,
  ),
);
if (context.target?.target) execFileSync('tmux', ['kill-window', '-t', context.target.target]);
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
