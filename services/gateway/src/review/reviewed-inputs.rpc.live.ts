// Opt-in isolated RPC proof: real Git fingerprints, gate-plan bookkeeping, durable store and API readback.
// The reviewer's structured result is scripted; no model, live farm or publication is used.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { Methods, type RunGetResult } from '@farmslot/protocol';

import { createNativeProofFixture } from '../runtime/native-proof-fixture.live-support.js';

test('a gate issues result durably settles only its launch fingerprint over isolated RPC', async (t) => {
  const output = process.env.FARMSLOT_REVIEW_INPUTS_PROOF_OUT;
  assert.ok(output);
  await mkdir(output, { recursive: true });
  await writeFile(
    path.join(output, 'proof.json'),
    JSON.stringify({ status: 'fail', target: 'isolated', liveRuns: 0, modelCalls: 0 }) + '\n',
  );
  const root = await mkdtemp(path.join(os.tmpdir(), 'review-inputs-rpc-'));
  const source = fileURLToPath(new URL('../../../../', import.meta.url));
  for (const key of Object.keys(process.env))
    if (/^(FARMSLOT_|GATEWAY_|GIT_CONFIG)/.test(key) || key === 'TMUX' || key === 'TMUX_PANE')
      delete process.env[key];
  Object.assign(process.env, {
    NODE_TEST_CONTEXT: '1',
    GATEWAY_HOST: '127.0.0.1',
    FARMSLOT_ROOT: root,
    FARMSLOT_HOME: path.join(root, 'home'),
    FARMSLOT_POOL_DIR: path.join(root, 'pool'),
    FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
    FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
    FARMSLOT_DISABLE_RUN_ENGINE_START: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  });
  for (const name of [
    'scripts',
    'packages',
    'services',
    'node_modules',
    'schemas',
    'package.json',
    'CLAUDE.md',
  ])
    await symlink(path.join(source, name), path.join(root, name));
  await mkdir(path.join(root, 'pool'));
  await mkdir(path.join(root, 'projects/farmslot-farm'), { recursive: true });
  await writeFile(
    path.join(root, 'projects/farmslot-farm/project.json'),
    JSON.stringify({
      name: 'farmslot-farm',
      external: { mock_mode: true },
      task_dir: '.sandbox/farmslot-farm/worker-task',
      hooks: {},
    }),
  );
  await import('../runtime/mock-pty.test-support.js');
  const { slotWithTask } = await import('./reviewed-inputs.test-support.js');
  const { getRun, persistRunNow, runsDirectory } = await import('../runs/store.js');
  const { noteReviewInputsAtLaunch, recordReviewedInputs, reviewedInputsAwaitingReview } =
    await import('./reviewed-inputs.js');
  const { executePublishGateReviewPlan } = await import('../run-engine/ready-gate.js');
  const { run, repo, artifacts } = await slotWithTask(t, 'TAT-4355');
  const fixture = await createNativeProofFixture(t, root);
  assert.notEqual(new URL(fixture.url).port, '7801');
  await import('../methods/run.js');
  await mkdir(path.dirname(getRun(run.id)!.taskFile!), { recursive: true });
  await writeFile(getRun(run.id)!.taskFile!, '# Isolated reviewed-inputs proof\n');
  await noteReviewInputsAtLaunch(run.id);
  await recordReviewedInputs(run.id);
  const passing = structuredClone(getRun(run.id)!.engineState!.reviewedInputs!);
  await writeFile(path.join(artifacts, 'on-after.png'), 'evidence offered to gate reviewer');
  const changed = await reviewedInputsAwaitingReview(getRun(run.id)!);
  assert.ok(changed);
  const before = await fixture.client.call<RunGetResult>(Methods.RUN_GET, { runId: run.id });
  assert.equal(before.run.engineState?.reviewedInputs?.rerunFor, undefined);
  const head = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const plan = await executePublishGateReviewPlan(
    run.id,
    getRun(run.id)!.slotId!,
    [{ runner: 'codex', model: 'gpt-6.1-sol', effort: 'high', mode: 'cold' }],
    'human-gate',
    {
      assertLaunchAllowed: async () => {},
      executeReview: async () => {
        await noteReviewInputsAtLaunch(run.id);
        return {
          verdict: 'issues',
          issues: [{ file: 'src/example.ts', description: 'Remaining finding' }],
          retryCount: 0,
          reviewerSessionId: 'scripted-review-session',
          reviewSnapshot: {
            source: 'local-git',
            headSha: head,
            capturedAt: new Date().toISOString(),
          },
        };
      },
    },
  );
  const after = await fixture.client.call<RunGetResult>(Methods.RUN_GET, { runId: run.id });
  assert.equal(after.run.engineState?.publishGate?.reviews?.at(-1)?.id, plan.reviewIds[0]);
  assert.equal(after.run.engineState?.publishGate?.reviews?.at(-1)?.verdict, 'issues');
  assert.equal(after.run.engineState?.reviewedInputs?.fingerprint, passing.fingerprint);
  assert.equal(after.run.engineState?.reviewedInputs?.recordedAt, passing.recordedAt);
  assert.equal(after.run.engineState?.reviewedInputs?.rerunFor, changed);
  assert.equal(await reviewedInputsAwaitingReview(getRun(run.id)!), null);
  await persistRunNow(getRun(run.id)!, 'proof readback');
  const saved = JSON.parse(await readFile(path.join(runsDirectory(), `${run.id}.json`), 'utf8'));
  assert.equal(saved.engineState.reviewedInputs.rerunFor, changed);
  await writeFile(path.join(artifacts, 'on-after.png'), 'unreviewed edit after gate review');
  assert.notEqual(await reviewedInputsAwaitingReview(getRun(run.id)!), null);
  await writeFile(
    path.join(output, 'proof.json'),
    JSON.stringify(
      {
        status: 'pass',
        target: 'isolated',
        runId: run.id,
        liveRuns: 0,
        modelCalls: 0,
        passingBaselinePreserved: true,
        issuesRowPersisted: true,
        launchFingerprintMarked: true,
        rpcReadback: true,
        durableReadback: true,
        laterEditStillUnreviewed: true,
      },
      null,
      2,
    ) + '\n',
  );
});
