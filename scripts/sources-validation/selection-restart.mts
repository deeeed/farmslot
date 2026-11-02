/** Manual source-selection restart proof against owned native workers and Git worktrees. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  isTerminalRunStatus,
  type NativeSessionReadResult,
  type NativeWorkerSessionBinding,
  type Run,
  type RunCancelResult,
  type RunDecision,
} from '@farmslot/protocol';

import type { GatewayClient } from '../../packages/cli/src/gateway-client.js';
import { readSlotRow } from '../../services/gateway/src/core/state.js';
import { getNode } from '../../services/gateway/src/fleet/machine-registry.js';
import { sendNodeRequest } from '../../services/gateway/src/fleet/node-rpc.js';
import { getRun } from '../../services/gateway/src/runs/store.js';

import type { ProofSourceUpstream } from './upstream.js';

interface SelectionRestartOptions {
  client: GatewayClient;
  node: { id: string; home: string };
  worker: { run: Run; binding: NativeWorkerSessionBinding };
  upstream: ProofSourceUpstream;
  proofRuns: string[];
  output: string;
  workerModel: string;
}

interface NodeExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface RestartObservation {
  slotId: string | null;
  validatedSlotId: string;
  lockDigest: string;
  resolvedDecisionId: string;
}

export async function proveSelectionRestart(options: SelectionRestartOptions) {
  const { client, node, worker, upstream, proofRuns, output, workerModel } = options;
  assert.ok(node.id.startsWith('source-proof-'));
  assert.ok(
    node.home.startsWith(path.resolve(output) + '/') ||
      node.home.split('/').some((part) => part.startsWith('source-proof-')),
  );
  const slotId = `${node.id}-consumer`;
  assert.equal(worker.run.slotId, slotId);
  const cwd = path.join(node.home, 'source-proof-worktree');
  const connection = getNode(node.id);
  assert.ok(connection, 'Selection proof requires the registered execution node');
  const closedRunIds: string[] = [];
  const ownedRuns: string[] = [];

  const execute = async (argv: string[], directory = cwd): Promise<NodeExecutionResult> => {
    const result = (await sendNodeRequest(connection, 'exec', {
      argv,
      cwd: directory,
      timeout: 30_000,
    })) as NodeExecutionResult;
    assert.equal(result.exitCode, 0, `${argv[0]} failed: ${result.stderr || result.stdout}`);
    return result;
  };
  const readRun = async (runId: string) =>
    (await client.call<{ run: Run }>('run.get', { runId })).run;
  const waitForRun = async (runId: string, ready: (run: Run) => boolean): Promise<Run> => {
    const deadline = Date.now() + 240_000;
    while (true) {
      const current = await readRun(runId);
      if (ready(current)) return current;
      assert.ok(
        !['failed', 'cancelled', 'blocked', 'reconciling'].includes(current.status),
        `${runId} ${current.status}: ${current.error}`,
      );
      if (Date.now() > deadline) throw new Error(`Selection proof timed out: ${runId}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };
  const target = (run: Run, binding: NativeWorkerSessionBinding) => {
    const context = run.agentContexts?.find(
      (item) => item.nativeSession?.sessionId === binding.sessionId,
    );
    assert.ok(context);
    assert.ok(binding.generation);
    return {
      sessionId: binding.sessionId,
      executionNodeId: binding.executionNodeId,
      worker: {
        runId: run.id,
        contextId: context.id,
        leaseId: binding.leaseId,
        generation: binding.generation,
      },
    };
  };
  const closeRun = async (runId: string) => {
    const current = await readRun(runId);
    for (const context of current.agentContexts ?? []) {
      const binding = context.nativeSession;
      if (!binding || binding.closedAt || binding.releasedAt || !binding.generation) continue;
      const closed = await client.call<NativeSessionReadResult>(
        'native.session.close',
        target(current, binding),
      );
      assert.equal(closed.session.processStopped, true);
    }
    if (!isTerminalRunStatus(current.status)) {
      const cancelled = await client.call<RunCancelResult>('run.cancel', { runId });
      assert.ok(
        !cancelled.effects?.some((effect) => effect.status === 'failed'),
        `Run cancellation cleanup failed: ${runId}`,
      );
    }
    if (!closedRunIds.includes(runId)) closedRunIds.push(runId);
  };
  const create = async (kind: 'fresh' | 'reset') => {
    const flow = kind === 'fresh' ? 'pr-complete' : 'dev';
    const taskFile = path.join(output, 'tasks', flow, `${node.id}-selection-${kind}`, 'TASK.md');
    await mkdir(path.dirname(taskFile), { recursive: true });
    const { writeNativeFixtureTask } = await import('../runner-validation/lib/native-task.mjs');
    const marker = `source-selection-${kind}.json`;
    const program = `const fs=require('node:fs');const receipt=JSON.parse(fs.readFileSync(process.env.FARMSLOT_SOURCE_RECEIPT,'utf8'));fs.writeFileSync('${marker}',JSON.stringify({lockDigest:receipt.lock.digest,nodeId:receipt.receipt.nodeId}))`;
    const quoted = `'${program.replaceAll("'", "'\\''")}'`;
    await writeNativeFixtureTask(
      taskFile,
      `# Worker: ${flow}\n\n## Checklist\n\n- [ ] Run exactly: node -e ${quoted}\n` +
        '- [ ] Check both boxes, then end this turn. Do not write a terminal signal, commit, publish, or contact another service.\n',
      worker.run.project,
    );
    const created = (
      await client.call<{ run: Run }>('run.createNative', {
        project: worker.run.project,
        flowType: flow,
        ticketOrPr: kind === 'fresh' ? 'deeeed/farmslot#1008' : `MANUAL-${Date.now()}`,
        branch: 'main',
        lane: worker.run.lane,
        allowedSlots: [slotId],
        taskFile,
        runner: 'codex',
        model: workerModel,
        effort: 'medium',
        mode: 'interactive',
        skipPrepare: true,
        safetyTier: 'full-auto',
        sourceSelections: [{ sourceId: 'proof-pack', selection: 'main' }],
      })
    ).run;
    proofRuns.push(created.id);
    ownedRuns.push(created.id);
    assert.equal(created.slotId, null);
    assert.ok(created.sourcePlan, 'Automatic creation must remain provisional');
    assert.equal(created.sourcePlan.validatedSlotId, undefined);
    return { created, marker };
  };
  const awaitWorker = async (runId: string, marker: string) => {
    const deadline = Date.now() + 240_000;
    while (true) {
      const current = await waitForRun(
        runId,
        (run) =>
          !!run.sourceProvenance &&
          !!run.agentContexts?.some((context) => context.nativeSession?.acceptedAt),
      );
      const binding = current.agentContexts!.find(
        (context) => context.nativeSession?.acceptedAt,
      )!.nativeSession!;
      const read = await client.call<NativeSessionReadResult>(
        'native.session.read',
        target(current, binding),
      );
      assert.ok(
        !['failed', 'closing', 'closed'].includes(read.session.state),
        `Selection worker stopped before its marker: ${runId} ${read.session.error ?? read.session.state}`,
      );
      if (read.session.state === 'idle') {
        const record = JSON.parse(
          (
            await execute([
              'node',
              '-e',
              `const fs=require('node:fs');process.stdout.write(fs.existsSync('${marker}')?fs.readFileSync('${marker}','utf8'):'null')`,
            ])
          ).stdout,
        );
        if (record) {
          assert.equal(record.lockDigest, current.sourceProvenance!.workerLock.digest);
          assert.equal(record.nodeId, node.id);
          return { run: current, binding, record };
        }
      }
      if (Date.now() > deadline)
        throw new Error(`Selection worker did not finish its marker: ${runId}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };
  const resolveAfterRestart = async (
    runId: string,
    reason: string,
    actionId: string,
    resetBranch = false,
  ) => {
    const pending = await waitForRun(runId, (run) =>
      run.decisions.some(
        (decision) => decision.type === `engine_${reason}` && !decision.resolvedAt,
      ),
    );
    const decision = pending.decisions.find(
      (item) => item.type === `engine_${reason}` && !item.resolvedAt,
    )!;
    assert.ok(decision.actions.some((action) => action.id === actionId));
    assert.equal(pending.sourcePlan?.validatedSlotId, undefined);
    return {
      pending,
      decision,
      resolve: async () => {
        const observations: RestartObservation[] = [];
        let samples = 0;
        // Read the production store while it awaits I/O. A replaced provisional
        // plan with automatic placement restored proves the outer restart ran.
        const observe = () => {
          samples++;
          const current = getRun(runId);
          const resolved = current?.decisions.find(
            (item) => item.id === decision.id && item.resolvedAt,
          );
          if (
            current?.sourcePlan?.validatedSlotId === slotId &&
            current.slotId === null &&
            resolved
          ) {
            const lockDigest = current.sourcePlan.lock.digest;
            if (!observations.some((item) => item.lockDigest === lockDigest))
              observations.push({
                slotId: current.slotId,
                validatedSlotId: slotId,
                lockDigest,
                resolvedDecisionId: resolved.id,
              });
          }
        };
        const timer = setInterval(observe, 1);
        try {
          await client.call('run.resolveDecision', {
            runId,
            decisionId: decision.id,
            actionId,
            ...(actionId === 'pick' ? { selectionData: { slotId, resetBranch } } : {}),
          });
          const selected = await waitForRun(runId, (run) =>
            run.steps.some((step) => step.name === 'find-slot' && step.status === 'done'),
          );
          assert.ok(
            observations.length > 0,
            'No replanned source snapshot with restored automatic placement was observed',
          );
          const retained: RunDecision[] = selected.decisions.filter(
            (item) => item.type === `engine_${reason}`,
          );
          assert.equal(retained.length, 1);
          assert.equal(retained[0].id, decision.id);
          assert.equal(retained[0].resolvedAction, actionId);
          return {
            decisionId: decision.id,
            initialPlanDigest: pending.sourcePlan!.lock.digest,
            samples,
            observedRestartSnapshots: observations.length,
            observations,
            outputs: selected.steps.find((step) => step.name === 'find-slot')!.outputs,
          };
        } finally {
          clearInterval(timer);
        }
      },
    };
  };

  const prove = async () => {
    assert.notEqual(
      worker.run.lane,
      'comparison',
      'Affinity Fresh requires a production or validation lane',
    );
    assert.equal((await execute(['git', 'branch', '--show-current'])).stdout.trim(), 'main');
    const freshInput = await create('fresh');
    const freshChoice = await resolveAfterRestart(
      freshInput.created.id,
      'branch_affinity_nudge',
      'fresh',
    );
    const freshSelection = await freshChoice.resolve();
    assert.equal(freshSelection.outputs?.selectionMethod, 'human-override');
    const fresh = await awaitWorker(freshInput.created.id, freshInput.marker);
    const prior = await client.call<NativeSessionReadResult>(
      'native.session.read',
      target(worker.run, worker.binding),
    );
    assert.ok(['closed', 'failed'].includes(prior.session.state));
    assert.equal(prior.session.processStopped, true);
    assert.notEqual(fresh.binding.sessionId, worker.binding.sessionId);
    assert.ok(fresh.run.sourceProvenance?.receiptIds.length);
    const freshEvidence = {
      ...freshSelection,
      runId: fresh.run.id,
      priorRunId: worker.run.id,
      priorSessionStopped: prior.session.processStopped,
      sessionId: fresh.binding.sessionId,
      provenance: fresh.run.sourceProvenance,
      marker: fresh.record,
    };
    await writeFile(
      path.join(output, 'selection-fresh-evidence.json'),
      JSON.stringify({ result: 'PASS', ...freshEvidence }, null, 2) + '\n',
    );
    await closeRun(worker.run.id);

    const resetInput = await create('reset');
    const resetChoice = await resolveAfterRestart(
      resetInput.created.id,
      'no_suitable_slot',
      'pick',
      true,
    );
    await execute(['git', 'remote', 'add', 'origin', upstream.repository]);
    await execute(['git', 'fetch', 'origin', 'main']);
    await closeRun(fresh.run.id);
    // Cancellation can preserve an occupancy fence. Release this exact stopped
    // worker's workspace through the public owner-bound path before resetting it.
    const beforeRelease = await readSlotRow(slotId);
    assert.ok(beforeRelease);
    let released: { released: boolean } | undefined;
    if (beforeRelease.current_run_id) {
      assert.equal(beforeRelease.current_run_id, fresh.run.id);
      released = await client.call<{ released: boolean }>('slot.release', {
        slotId,
        expectedRunId: fresh.run.id,
        keepWork: true,
      });
      assert.equal(released.released, true);
    } else {
      assert.ok(['ready', 'held'].includes(String(beforeRelease.lifecycle)));
      assert.ok(!beforeRelease.handoff_run_id);
      // A stopped worker can leave an unclaimed occupancy fence. Observe the
      // real workspace census from outside that workspace before releasing it.
      const census = `const {spawnSync}=require('node:child_process');const result=spawnSync('lsof',['-a','-d','cwd','-Fpn'],{encoding:'utf8'});if(result.status!==0&&result.status!==1)throw new Error('Workspace census failed');const root=${JSON.stringify(cwd)};let pid;const occupied=[];for(const line of result.stdout.split('\\n')){if(line.startsWith('p'))pid=Number(line.slice(1));if(line.startsWith('n')&&(line.slice(1)===root||line.slice(1).startsWith(root+'/')))occupied.push(pid)}console.log(JSON.stringify(occupied))`;
      const deadline = Date.now() + 30_000;
      for (;;) {
        const occupied = JSON.parse((await execute(['node', '-e', census], '/')).stdout);
        if (!occupied.length) break;
        assert.ok(Date.now() < deadline, `Workspace remains occupied: ${occupied.join(', ')}`);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (beforeRelease.lifecycle === 'held') {
        released = await client.call<{ released: boolean }>('slot.release', {
          slotId,
          keepWork: true,
          preserveAgents: true,
        });
        assert.equal(released.released, true);
      }
    }
    await writeFile(
      path.join(output, 'selection-slot-release.json'),
      JSON.stringify(
        { result: 'PASS', slotId, expectedRunId: fresh.run.id, beforeRelease, released },
        null,
        2,
      ) + '\n',
    );
    await execute(['git', 'checkout', '-B', 'source-proof-reset', 'origin/main']);
    const dirtyFile = 'source-proof-reset-dirty.txt';
    await execute([
      'node',
      '-e',
      `require('node:fs').writeFileSync('${dirtyFile}','reset must remove this')`,
    ]);
    const before = (await execute(['git', 'status', '--porcelain'])).stdout;
    assert.ok(before.includes(dirtyFile));
    const resetSelection = await resetChoice.resolve();
    assert.equal(resetSelection.outputs?.resetBranch, true);
    assert.equal(resetSelection.outputs?.selectionMethod, 'human-override');
    const reset = await awaitWorker(resetInput.created.id, resetInput.marker);
    const branch = (await execute(['git', 'branch', '--show-current'])).stdout.trim();
    const head = (await execute(['git', 'rev-parse', 'HEAD'])).stdout.trim();
    const base = (await execute(['git', 'rev-parse', 'origin/main'])).stdout.trim();
    assert.equal(branch, 'main');
    assert.equal(head, base);
    await execute([
      'node',
      '-e',
      `require('node:assert/strict').equal(require('node:fs').existsSync('${dirtyFile}'),false)`,
    ]);
    return {
      fresh: freshEvidence,
      reset: {
        ...resetSelection,
        runId: reset.run.id,
        dirtyBefore: before,
        branch,
        head,
        base,
        dirtyFileRemoved: true,
        provenance: reset.run.sourceProvenance,
      },
      closedRunIds,
    };
  };
  const outcome = await prove().then(
    (value) => ({ status: 'fulfilled' as const, value }),
    (reason) => ({ status: 'rejected' as const, reason }),
  );
  const failures: unknown[] = outcome.status === 'rejected' ? [outcome.reason] : [];
  for (const runId of ownedRuns) {
    try {
      await closeRun(runId);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, 'Selection proof or cleanup failed');
  assert.equal(outcome.status, 'fulfilled');
  return outcome.value;
}
