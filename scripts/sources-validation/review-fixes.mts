/** Manual source review-fix proof against the production authority, gateway and nodes. */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { createSourceCommandClient, type Principal, type Run } from '@farmslot/protocol';

import { GatewayClient } from '../../packages/cli/src/gateway-client.js';
import { loadFleetStatus } from '../../services/gateway/src/fleet/state.js';
import { createRun, getRun, persistRunNow } from '../../services/gateway/src/runs/store.js';
import { runWithSessionOriginator } from '../../services/gateway/src/security/work-originator.js';
import * as runtime from '../../services/gateway/src/sources/runtime.js';

import type { ProofSourceUpstream } from './upstream.js';

interface ReviewFixProofOptions {
  client: GatewayClient;
  upstream: ProofSourceUpstream;
  nodeId: string;
  principal: Principal;
  workerModel: string;
  proofRuns: string[];
  output: string;
}

export async function proveSourceReviewFixes(options: ReviewFixProofOptions) {
  const { client, upstream, nodeId, principal, workerModel, proofRuns, output } = options;
  const commands = createSourceCommandClient((method, params) => client.call(method, params));
  const evidence: Record<string, unknown> = {};
  runtime.stopSourceReconciliation();
  for (const phase of ['candidate', 'node-admission'] as const) {
    const params = {
      flowType: 'dev' as const,
      project: 'source-proof',
      ticketOrPr: `MANUAL-${Date.now()}`,
      mode: 'interactive' as const,
      runner: 'codex',
      skipPrepare: true,
      allowedSlots: [`${nodeId}-consumer`],
      sourceSelections: [
        { sourceId: 'proof-pack', selection: 'branch' as const, ref: 'experiment/run' },
      ],
    };
    const run = (await client.call<{ run: Run }>('run.create', params)).run;
    proofRuns.push(run.id);
    assert.equal(run.sourceProvenance, undefined);
    const originalGeneration = run.engineState?.generation ?? 0;
    await upstream.advance('experiment/run', `review-replay-${phase}`);
    await runtime.sourceAuthority()!.reconcile();
    if (phase === 'node-admission') {
      await commands.execute(
        await commands.preparePin({
          sourceId: 'proof-pack',
          ref: 'experiment/run',
          scope: 'run',
          targetId: run.id,
        }),
      );
      // Publish only the node-specific provisional plan, never an execution receipt.
      try {
        await runtime.refreshRunSourcePlan(run.id, { nodeId, slotId: params.allowedSlots[0] });
      } catch (error) {
        if (!(error instanceof runtime.SourcePlanRestart)) throw error;
      }
      assert.equal(getRun(run.id)!.sourcePlan!.validatedSlotId, params.allowedSlots[0]);
      assert.equal(getRun(run.id)!.sourceProvenance, undefined);
    }
    let replay: Promise<PromiseSettledResult<unknown>> | undefined;
    const stop = upstream.onNextRequest(() => {
      // The actual RPC performs its own generation bump and preserves the foreign slot owner.
      replay = client.call('run.replayStep', { runId: run.id, stepName: 'find-slot' }).then(
        (value) => ({ status: 'fulfilled' as const, value }),
        (reason) => ({ status: 'rejected' as const, reason }),
      );
    });
    try {
      const current = getRun(run.id)!;
      const action =
        phase === 'candidate'
          ? runtime.planRunSourceSlots(current, (await loadFleetStatus(true)).slots)
          : runtime.admitRunSources(run.id, { nodeId, slotId: params.allowedSlots[0] });
      await assert.rejects(action, /Run ownership or source plan changed/);
      assert(replay, 'A real Git request must trigger the concurrent replay');
      const replayResult = await replay;
      if (replayResult.status === 'rejected') throw replayResult.reason;
      const latest = (await client.call<{ run: Run }>('run.get', { runId: run.id })).run;
      assert((latest.engineState?.generation ?? 0) > originalGeneration);
      assert.equal(latest.sourceProvenance, undefined);
      evidence[phase] = {
        runId: run.id,
        originalGeneration,
        generation: latest.engineState?.generation,
        noProvenance: true,
        realFetch: true,
      };
    } finally {
      stop();
      if (replay) await replay;
      await client.call('run.cancel', { runId: run.id });
    }
  }

  // Use the same creation producer and seal as run.create, while leaving this
  // provisional static run parked so a review worker cannot begin external PR work.
  const qaRun = await runWithSessionOriginator(principal, () =>
    runtime.withSourceCreationPlan(
      {
        flowType: 'review-pr',
        project: 'source-proof',
        ticketOrPr: 'deeeed/farmslot#1008',
        mode: 'autonomous',
        reviewWorkspaceTarget: { machine: nodeId },
        runner: 'codex',
        model: workerModel,
        effort: 'medium',
        transport: 'native',
        reviewAutoFinish: false,
      },
      {},
      async (plan, seal, runId) => {
        assert(plan && seal);
        const run = await seal(() =>
          createRun(plan.params, {
            runId,
            createdByPrincipalId: principal.id,
            nativeOwnerPrincipalId: principal.id,
            dispatchRequest: plan.params,
            workflowExecution: plan.workflowExecution,
            qaAfterReview: plan.qaAfterReview,
            directReviewPublication: plan.directReviewPublication,
          }),
        );
        await persistRunNow(run);
        await runtime.completeRunSourceCreation(run.id);
        return run;
      },
    ),
  );
  proofRuns.push(qaRun.id);
  const qaSnapshot = structuredClone(qaRun.qaAfterReview);
  assert(qaSnapshot);
  await commands.execute(
    await commands.preparePin({
      sourceId: 'proof-pack',
      ref: 'experiment/node',
      scope: 'run',
      targetId: qaRun.id,
    }),
  );
  const after = (await client.call<{ run: Run }>('run.get', { runId: qaRun.id })).run;
  assert.deepEqual(after.qaAfterReview, qaSnapshot);
  assert.equal(after.sourcePlan!.lock.entries[0].effectiveRef, 'experiment/node');
  assert.equal(after.reviewWorkspaceTarget!.machine, nodeId);
  assert.equal(after.sourceProvenance, undefined);
  evidence.staticAutomaticQa = {
    runId: qaRun.id,
    qaSnapshot,
    replannedQa: after.qaAfterReview,
    plan: after.sourcePlan,
    noWorkerStarted: !after.agentContexts?.length,
  };
  // Terminalize through the real cancellation RPC; a parked run has no worker.
  await client.call('run.cancel', { runId: qaRun.id });
  await writeFile(
    path.join(output, 'review-fixes-evidence.json'),
    JSON.stringify({ result: 'PASS', evidence }, null, 2) + '\n',
  );
  return evidence;
}
