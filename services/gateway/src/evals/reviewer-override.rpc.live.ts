// Opt-in RPC recipe in a disposable farm. Seeds worker output; launches no workers or slots.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  type DispatchQueueAddResult,
  type DispatchQueueListResult,
  type EvalPackageAxes,
  type EvalTrialResultGetResult,
  type EvalTrialStartParams,
  type EvalTrialStartResult,
  isSuccessfulRun,
  Methods,
} from '@farmslot/protocol';

import { createNativeProofFixture } from '../runtime/native-proof-fixture.live-support.js';

test('eval reviewer override and unjudged readback RPC recipe', async (t) => {
  const root = await mkdtemp('/tmp/eval-reviewer-rpc-');
  assert.equal(process.env.TMUX, undefined, 'Run with TMUX unset');
  assert.ok(process.env.TMUX_TMPDIR, 'Run with a private TMUX_TMPDIR');
  const project = 'eval-reviewer-fixture';
  for (const dir of ['pool', 'scripts', 'services/gateway', `projects/${project}`])
    await mkdir(path.join(root, dir), { recursive: true });
  await writeFile(path.join(root, 'CLAUDE.md'), '# Disposable eval RPC fixture\n');
  await writeFile(path.join(root, 'scripts/dev.sh'), '#!/bin/sh\nexit 1\n');
  await writeFile(path.join(root, 'services/gateway/package.json'), '{}');
  await writeFile(
    path.join(root, `projects/${project}/project.json`),
    JSON.stringify({
      name: project,
      task_dir: 'tasks',
      hooks: {},
      review: { enabled: true, runner: 'codex' },
    }),
  );
  process.env.FARMSLOT_TEST_STATUS_FILE = path.join(root, 'fixture-status.json');
  await writeFile(process.env.FARMSLOT_TEST_STATUS_FILE, '{"slots":[]}');
  const { client } = await createNativeProofFixture(t, root);
  const { createRun, getRun, updateRun, persistRunNow } = await import('../runs/store.js');
  const { firstOutputFixture } = await import('./first-output.test-support.js');
  const {
    computeCandidateStrategyFingerprint,
    readEvalExperimentManifest,
    readResultPackageManifest,
    writeEvalExperimentManifest,
    writeResultPackageManifest,
    freezeEvalFirstOutputPackage,
    finalizeEvalResultPackageForRun,
  } = await import('./package-store.js');
  const run = createRun({
    project,
    flowType: 'fix-bug',
    ticketOrPr: 'EVAL-REVIEWER',
    mode: 'autonomous',
    completionPolicy: 'artifact-only',
    lane: 'comparison',
    variant: 'rpc',
  });
  const fixture = await firstOutputFixture(root, run);
  const link = fixture.engineState!.evalExperiment!;
  const axes: EvalPackageAxes = { template: { path: 'fix-bug.md', hash: 'fixture-template' } };
  const fingerprint = computeCandidateStrategyFingerprint({
    axes,
    taskProfile: 'fix-bug',
    startRef: link.blind!.baseSha,
  });
  const trialId = `trial-${fingerprint.slice(0, 12)}-rpc`;
  const strategyId = `strategy-${fingerprint.slice(0, 12)}`;
  const manifest = await readEvalExperimentManifest(link.experimentManifestPath);
  const referencePackagePath = path.join(root, 'gateway/reference.json');
  await writeResultPackageManifest(referencePackagePath, {
    ...(await readResultPackageManifest(link.packagePath)),
    role: 'reference',
    baseline: { source: 'local-git', baseSha: link.blind!.baseSha, capturedAt: run.createdAt },
  });
  manifest.case.referencePackagePath = referencePackagePath;
  manifest.trials[0] = { ...manifest.trials[0], trialId, strategyId };
  manifest.candidateStrategies = [
    { strategyId, label: 'RPC', axes, candidateStrategyFingerprint: fingerprint },
  ];
  await writeEvalExperimentManifest(link.experimentManifestPath, manifest);
  const params: EvalTrialStartParams = {
    project,
    experimentManifestPath: link.experimentManifestPath,
    axes,
    trialId: 'rpc',
    reviewRunner: 'pi',
    reviewModel: 'litellm/claude-sonnet-5-5',
  };
  await t.test(
    'legacy trial rejects an explicit reviewer and invalid models before deduplication',
    async () => {
      const retained = await readFile(link.experimentManifestPath, 'utf8');
      await assert.rejects(
        client.call(Methods.EVAL_TRIAL_START, params),
        /conflicts with retained trial/,
      );
      await assert.rejects(
        client.call(Methods.EVAL_TRIAL_START, {
          ...params,
          reviewRunner: 'codex',
          reviewModel: 'opus',
        }),
        /does not support model/,
      );
      assert.equal(await readFile(link.experimentManifestPath, 'utf8'), retained);
    },
  );
  manifest.trials[0] = {
    ...manifest.trials[0],
    reviewRunner: params.reviewRunner,
    reviewModel: params.reviewModel,
  };
  await writeEvalExperimentManifest(link.experimentManifestPath, manifest);
  Object.assign(link, {
    trialId,
    candidateStrategyFingerprint: fingerprint,
    reviewRunner: params.reviewRunner,
    reviewModel: params.reviewModel,
  });
  updateRun(run.id, { taskFile: fixture.taskFile, engineState: fixture.engineState });
  await t.test(
    'matching reviewer deduplicates and a changed reviewer rejects without rewriting',
    async () => {
      const retained = await readFile(link.experimentManifestPath, 'utf8');
      const result = await client.call<EvalTrialStartResult>(Methods.EVAL_TRIAL_START, params);
      assert.equal(result.deduped, true);
      assert.equal(result.run?.id, run.id);
      await assert.rejects(
        client.call(Methods.EVAL_TRIAL_START, {
          ...params,
          reviewRunner: 'claude',
          reviewModel: 'opus',
        }),
        /conflicts with retained trial/,
      );
      assert.equal(await readFile(link.experimentManifestPath, 'utf8'), retained);
    },
  );
  await t.test(
    'unknown queued keys cancel permanently and a later cell dispatches over RPC',
    async () => {
      const queue = await import('../backlog/dispatch-queue.js');
      const { setCachedFleetForTests } = await import('../fleet/state.js');
      const { evalTrialStart } = await import('../methods/eval.js');
      t.after(() => queue.resetDispatchQueueForTests());
      queue.setQueueDispatchPressureCaptureForTests(() => new Map());
      setCachedFleetForTests({
        checkedAt: new Date().toISOString(),
        slots: [
          {
            slot: 'eval-rpc-slot',
            machine: 'disposable',
            project,
            platform: 'cli',
            health: { ssh: 'LOCAL', device: '-', devserver: 'OK', cdp: '-', fixtures: '-' },
            branch: 'main',
            agent: 'idle',
            enabled: true,
            dispatchable: true,
            lifecycle: 'ready',
            phase: null,
            warm: false,
            taskId: null,
            taskFile: null,
            currentRunId: null,
            currentFlowType: null,
            currentTicketOrPr: null,
            currentMode: null,
            currentFamilyId: null,
            currentLane: null,
            currentVariant: null,
            dispatchedAt: null,
            completedAt: null,
            runner: null,
            model: null,
            deviceName: null,
            taskPhase: null,
            taskStepProgress: null,
          },
        ],
        summary: {
          total: 1,
          ready: 1,
          busy: 0,
          held: 0,
          manual: 0,
          disabled: 0,
          blocked: 0,
          warmCount: 0,
        },
      });
      const enqueue = (cellId: string, extra: Record<string, unknown> = {}) =>
        client.call<DispatchQueueAddResult>(Methods.DISPATCH_QUEUE_ADD, {
          queueKind: 'eval-cell',
          flowType: 'fix-bug',
          project,
          ticketOrPr: cellId,
          slotId: 'eval-rpc-slot',
          autoDispatch: false,
          evalCell: {
            capGroupId: 'rpc-unknown-params',
            experimentId: 'unknown-params-experiment',
            cellId,
            experimentManifestPath: params.experimentManifestPath,
            trialId: 'rpc',
            trialStartParams: { ...params, ...extra },
          },
        });
      const invalid = (await enqueue('invalid-cell', { reveiw: false })).item;
      const later = (await enqueue('later-cell')).item;
      const attempted: string[] = [];
      queue.initDispatchQueue(
        () => {},
        async (item, claim) => {
          queue.assertQueueClaimHeld(claim, 'rpc-eval-start');
          attempted.push(item.id);
          const result = await evalTrialStart(
            { ...params, ...item.evalCell!.trialStartParams },
            () => {},
          );
          assert.equal(result.deduped, true);
          assert.equal(result.run?.id, run.id);
        },
      );
      await queue.tryDispatchNext();
      assert.equal(
        queue.getQueueSnapshot().find((item) => item.id === invalid.id)?.status,
        'cancelled',
      );
      const pending = await client.call<DispatchQueueListResult>(Methods.DISPATCH_QUEUE_LIST);
      assert.deepEqual(
        pending.items.map((item) => item.id),
        [later.id],
      );
      await queue.tryDispatchNext();
      await queue.tryDispatchNext();
      assert.deepEqual(attempted, [invalid.id, later.id]);
      assert.deepEqual(
        (await client.call<DispatchQueueListResult>(Methods.DISPATCH_QUEUE_LIST)).items,
        [],
      );
    },
  );
  await t.test('unknown keys and contradictory reviewer choices reject over RPC', async () => {
    for (const invalid of [{ reviewer: 'x' }, { reveiw: false }])
      await assert.rejects(
        client.call(Methods.EVAL_TRIAL_START, { ...params, ...invalid }),
        /Invalid eval.trial.start params: unknown key\(s\): .*; allowed:/,
      );
    await assert.rejects(
      client.call(Methods.EVAL_TRIAL_START, { ...params, review: false }),
      /review:false cannot be combined/,
    );
  });
  // Seed a retained worker-only trial, then re-enter through the public RPC and
  // review orchestrator. Project judging stays enabled with the default codex reviewer.
  delete manifest.trials[0].reviewRunner;
  delete manifest.trials[0].reviewModel;
  manifest.trials[0].review = false;
  await writeEvalExperimentManifest(link.experimentManifestPath, manifest);
  delete link.reviewRunner;
  delete link.reviewModel;
  link.review = false;
  updateRun(run.id, { engineState: fixture.engineState });
  const workerOnlyParams = { ...params };
  delete workerOnlyParams.reviewRunner;
  delete workerOnlyParams.reviewModel;
  await t.test(
    'worker-only choice survives idempotent RPC starts and conflicting retries reject',
    async () => {
      for (const choice of [{ review: false as const }, {}]) {
        const result = await client.call<EvalTrialStartResult>(Methods.EVAL_TRIAL_START, {
          ...workerOnlyParams,
          ...choice,
        });
        assert.equal(result.deduped, true);
        assert.equal(result.run?.id, run.id);
        assert.equal(result.run?.engineState?.evalExperiment?.review, false);
      }
      await assert.rejects(
        client.call(Methods.EVAL_TRIAL_START, params),
        /conflicts with retained trial/,
      );
    },
  );
  await t.test('disabled judge finalizes and reads back as unjudged over RPC', async () => {
    const { executeReview } = await import('../review/orchestrator.js');
    await freezeEvalFirstOutputPackage(getRun(run.id)!, {});
    const slotId = 'disposable-review-slot';
    updateRun(run.id, { slotId });
    await writeFile(
      path.join(root, 'fixture-status.json'),
      JSON.stringify({
        slots: [{ slot: slotId, current_run_id: run.id, slot_epoch: 1 }],
      }),
    );
    const review = await executeReview(run.id, slotId);
    assert.deepEqual(
      await executeReview(run.id, slotId),
      review,
      'retry must retain the judging opt-out',
    );
    assert.equal(review.reason, 'disabled-for-project');
    assert.equal(review.skipped, true);
    updateRun(run.id, {
      status: 'completing',
      slotId: null,
      steps: run.steps.map((step) => ({
        ...step,
        status: 'done',
        ...(step.name === 'review' ? { outputs: { ...review } } : {}),
      })),
    });
    await freezeEvalFirstOutputPackage(getRun(run.id)!, {});
    await finalizeEvalResultPackageForRun(getRun(run.id)!);
    const { startRun } = await import('../run-engine/orchestrator.js');
    await startRun(run.id);
    await persistRunNow(getRun(run.id)!);
    const result = await client.call<EvalTrialResultGetResult>(Methods.EVAL_TRIAL_RESULT_GET, {
      runId: run.id,
    });
    assert.equal(result.run.status, 'done');
    assert.equal(result.run.metrics.outcome, 'unjudged');
    assert.equal(isSuccessfulRun(result.run), false);
    assert.equal(result.candidatePackage.status, 'final');
    assert.deepEqual(result.candidatePackage.reviewEvidence, []);
    assert.equal(result.experimentManifest?.trials[0].status, 'final');
    assert.equal(result.experimentManifest?.trials[0].review, false);
  });
});
