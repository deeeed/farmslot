// A single model/tool call through blind admission, on the fullflow stack's own slot and manifest.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import {
  cancelledRunSlotHold,
  isTerminalRunStatus,
  type EvalExperimentCreateResult,
  type EvalTrialStartResult,
  type WorkerSessionHistoryGetResult,
  type Run,
  type RunCancelResult,
  type SlotReleaseResult,
  type SlotStatus,
} from '../../../packages/protocol/src/index.js';
import { writeResultPackageManifest } from '../../../services/gateway/src/evals/package-store.js';
import { writeJson } from '../lib/isolated-stack.mjs';
import type { RemoteNodeStack } from '../lib/remote-node-stack.mjs';

import { FULLFLOW_PROJECT } from './fullflow-fixture.mjs';
import { firstBlindTool, readCanaryTurns, type BlindToolMessage } from './blind-dispatch-proof.js';
import type { CheckResult } from './outcome.mjs';
import { type Log } from './run-driver.mjs';

interface BlindDispatchOptions {
  stack: RemoteNodeStack;
  evidence: string;
  worker: { runner: string; model: string };
  signal: AbortSignal;
  turnReceipts: string;
  log: Log;
  onCheck(check: CheckResult): void;
}

export async function runBlindDispatch(options: BlindDispatchOptions): Promise<void> {
  const { stack, worker, signal, log } = options;
  const slotId = `${FULLFLOW_PROJECT}-blind-dispatch-1`;
  const dir = path.join(options.evidence, 'blind-dispatch');
  const referenceRoot = path.join(stack.fixture, 'node-home', 'canary-reference');
  const started = Date.now();
  const readSlot = async () =>
    (await stack.call<{ fleet: { slots: SlotStatus[] } }>('fleet.status')).fleet.slots.find(
      (slot) => slot.slot === slotId,
    );
  const check: CheckResult = {
    case: 'blind-dispatch',
    variant: '-',
    target: 'isolated',
    status: 'fail',
    model: `${worker.runner} ${worker.model}`,
    modelCalls: 0,
    differences: [],
    observations: [],
    evidence: dir,
  };
  options.onCheck(check);
  let run: Run | undefined;
  await mkdir(dir, { recursive: true });
  try {
    // Make a real hidden answer in a separate repository, without adding objects to the slot.
    await mkdir(referenceRoot, { recursive: true });
    const answer = path.join(referenceRoot, 'answer');
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
    git(stack.fixture, 'clone', '--no-local', '-q', stack.slotRepo(slotId), answer);
    const baseSha = git(answer, 'rev-parse', 'HEAD');
    await writeFile(path.join(answer, 'src/sum.mjs'), 'export const sum = (a, b) => a + b;\n');
    git(
      answer,
      '-c',
      'user.name=Canary Fixture',
      '-c',
      'user.email=canary@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-qam',
      'fixture: correct sum',
    );
    const headSha = git(answer, 'rev-parse', 'HEAD');
    const packagePath = path.join(
      referenceRoot,
      'artifacts/packages/reference.result-package.json',
    );
    await writeFile(
      path.join(referenceRoot, 'reference.diff'),
      git(answer, 'diff', baseSha, headSha) + '\n',
    );
    const at = new Date().toISOString();
    await writeResultPackageManifest(packagePath, {
      version: 1,
      kind: 'result-package',
      packageId: 'canary-blind-reference',
      packageHash: '',
      status: 'final',
      createdAt: at,
      finalizedAt: at,
      project: FULLFLOW_PROJECT,
      familyId: 'canary-blind-dispatch',
      objectiveHash: 'canary-blind-sum',
      taskProfile: 'fix-bug',
      role: 'reference',
      source: { kind: 'git-ref', ref: headSha, baseSha, headSha },
      baseline: { source: 'local-git', baseSha, capturedAt: at },
      diff: {
        source: 'artifact',
        available: true,
        files: 1,
        additions: 1,
        deletions: 1,
        kind: 'contribution',
        baseSha,
        headSha,
        artifactPath: 'reference.diff',
      },
      axes: {},
      visualEvidence: [],
      validationEvidence: [],
      reviewEvidence: [],
      outcomeClaims: [],
      missingData: [],
    });
    await rm(answer, { recursive: true });
    const experiment = await stack.call<EvalExperimentCreateResult>('eval.experiment.create', {
      project: FULLFLOW_PROJECT,
      source: { kind: 'package', packagePath },
      taskProfile: 'fix-bug',
      familyId: 'canary-blind-dispatch',
      objective:
        'Correct sum subtraction. Work only in this tiny repository and its task. Never push, publish or contact GitHub.\n\nAcceptance criteria:\n- node cli.mjs 2 3 prints 5.',
    });
    await writeJson(path.join(dir, 'experiment.json'), experiment);
    assert.equal(experiment.experimentManifest.datasetId, undefined);
    assert.equal(experiment.experimentManifest.datasetItemId, undefined);
    const trial = await stack.call<EvalTrialStartResult>('eval.trial.start', {
      project: FULLFLOW_PROJECT,
      experimentManifestPath: experiment.experimentManifestPath,
      axes: {},
      ...worker,
      effort: 'low',
      review: false,
      slotId,
      allowedSlots: [slotId],
      trialId: 'dispatch-smoke',
    });
    assert(trial.run, 'Blind trial did not create a run');
    run = trial.run;
    check.runId = run.id;
    await log('blind-dispatch: run created', { runId: run.id, slotId });
    await writeJson(path.join(dir, 'start.json'), trial);
    const deadline = started + 5 * 60_000;
    let tool: BlindToolMessage | undefined;
    let proofSource = '';
    let previousState = '';
    while (!tool) {
      signal.throwIfAborted();
      assert(
        Date.now() < deadline,
        'Blind dispatch did not reach a model/tool call within five minutes',
      );
      run = (await stack.call<{ run: Run }>('run.get', { runId: run.id })).run;
      const state = [run.status, ...run.steps.map((step) => `${step.name}:${step.status}`)].join(
        ' ',
      );
      if (state !== previousState) {
        await writeJson(path.join(dir, 'run-latest.json'), run);
        await log('blind-dispatch: state', { runId: run.id, state });
        previousState = state;
      }
      assert(
        !isTerminalRunStatus(run.status) && !['needs-decision', 'blocked'].includes(run.status),
        `Blind trial stopped before a model/tool call: ${run.status}: ${run.error ?? ''}`,
      );
      if (run.steps.some((step) => step.name === 'dispatch' && step.status === 'done')) {
        const history: WorkerSessionHistoryGetResult =
          await stack.call<WorkerSessionHistoryGetResult>('worker.session.history.get', {
            runId: run.id,
            limit: 100,
          });
        const snapshot = history.snapshot;
        assert.equal(snapshot.runId, run.id);
        await writeJson(path.join(dir, 'history-latest.json'), snapshot);
        tool = firstBlindTool(snapshot);
        proofSource = snapshot.source;
        if (!tool) {
          const receipts = await readCanaryTurns(
            options.turnReceipts,
            stack.slotRepo(slotId),
            started,
          );
          check.modelCalls = receipts.length;
          tool = firstBlindTool({ source: 'structured-hook', messages: receipts });
          if (tool) {
            proofSource = 'structured-hook';
            await writeJson(path.join(dir, 'provider-turns.json'), receipts);
          }
        }
      }
      if (!tool) await delay(500, undefined, { signal });
    }
    check.modelCalls = Math.max(1, check.modelCalls);
    run = (await stack.call<{ run: Run }>('run.get', { runId: run.id })).run;
    await writeJson(path.join(dir, 'first-model-tool.json'), {
      source: proofSource,
      message: tool,
    });
    for (const name of ['find-slot', 'write-task', 'prepare', 'dispatch'])
      assert(
        run.steps.some((step) => step.name === name && step.status === 'done'),
        `${name} did not complete`,
      );
    assert.equal(run.engineState?.evalExperiment?.blind?.executionPolicy, 'normal-slot');
    assert.equal(run.engineState?.evalExperiment?.blind?.isolation, undefined);
    assert.equal(run.engineState?.evalExperiment?.blind?.workspace?.slotId, slotId);
    assert(
      run.engineState?.evalExperiment?.blind?.workspace?.baseVerifiedAt,
      'Initial base was not verified',
    );
    assert.equal(run.startRef?.resolvedSha, baseSha);
    assert(run.taskFile, 'Blind trial has no task');
    await mkdir(path.join(dir, 'task/inputs'), { recursive: true });
    for (const file of ['TASK.md', 'CHECKLIST.md', 'inputs/handoff.json'])
      await copyFile(path.join(path.dirname(run.taskFile), file), path.join(dir, 'task', file));
    const handoff = JSON.parse(await readFile(path.join(dir, 'task/inputs/handoff.json'), 'utf8'));
    assert.deepEqual(handoff.task.acceptanceCriteria, ['node cli.mjs 2 3 prints 5.']);
    check.status = 'pass';
    check.observations.push(
      'Normal-slot replay admission and task-init reached a task-bound structured model tool call; no dataset manifest.',
    );
  } catch (error) {
    await writeFile(
      path.join(dir, 'checkout-status.txt'),
      execFileSync('git', ['status', '--porcelain'], {
        cwd: stack.slotRepo(slotId),
        encoding: 'utf8',
      }),
    );
    check.error = String(error);
    check.differences.push(check.error);
  } finally {
    if (run) {
      try {
        const current = (await stack.call<{ run: Run }>('run.get', { runId: run.id })).run;
        if (!isTerminalRunStatus(current.status)) {
          const cancelled = await stack.call<RunCancelResult>('run.cancel', {
            runId: run.id,
            reason: 'canary: blind dispatch observation recorded',
          });
          await writeJson(path.join(dir, 'cancel.json'), cancelled);
          assert(
            !(cancelled.effects ?? []).some((effect) => effect.status === 'failed'),
            'Blind cancellation effect failed',
          );
        }
        const slot = await readSlot();
        const hold = slot && cancelledRunSlotHold(slot);
        if (hold) {
          assert.equal(hold.runId, run.id);
          const released = await stack.call<SlotReleaseResult>('slot.release', hold.releaseParams);
          assert(released.released, released.reason);
        }
        const final = (await stack.call<{ run: Run }>('run.get', { runId: run.id })).run;
        assert.equal(final.engineState?.evalExperiment?.blind?.isolation, undefined);
        await stack.call('fleet.refresh');
        const after = await readSlot();
        await writeJson(path.join(dir, 'slot-after.json'), after);
        assert.equal(after?.lifecycle, 'ready');
        assert.equal(after?.branch, 'main');
        assert(
          !after?.currentRunId && !after?.cleanupRunId && !after?.handoffRunId,
          'Blind cleanup left a slot owner',
        );
        assert(!after?.repoBlocker, after?.repoBlocker);
        const archived = await stack.call<{ ok: boolean }>('run.archive', { runId: run.id });
        assert(archived.ok, 'Blind trial archive failed');
        await writeJson(path.join(dir, 'archive.json'), archived);
        await cp(referenceRoot, path.join(dir, 'reference'), { recursive: true });
      } catch (error) {
        check.status = 'fail';
        check.differences.push(`cleanup: ${String(error)}`);
      }
    }
    check.durationS = Math.round((Date.now() - started) / 100) / 10;
    await writeJson(path.join(dir, 'check.json'), check);
    await log(`blind-dispatch: ${check.status}`, {
      runId: check.runId,
      differences: check.differences,
      durationS: check.durationS,
    });
  }
}
