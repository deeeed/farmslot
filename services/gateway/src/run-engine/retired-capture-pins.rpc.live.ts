// Opt-in protocol proof. Uses disposable records and retained bytes, without dispatching work.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { Methods, type Run, type RunDecision } from '@farmslot/protocol';
import {
  collectRunBundleGarbage,
  materializeRunBundle,
  readRetainedRunBundle,
  runBundleHousekeepingPaths,
} from '@farmslot/run-bundle';

import { createNativeProofFixture } from '../runtime/native-proof-fixture.live-support.js';

test('retired receipt captures survive housekeeping and GC across an authenticated archive', async (t) => {
  const output = process.env.FARMSLOT_RETIRED_CAPTURE_PROOF_OUT;
  assert.ok(output);
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, 'proof.json'), JSON.stringify({ status: 'fail' }) + '\n');
  const root = await mkdtemp(path.join(os.tmpdir(), 'retired-capture-rpc-'));
  for (const key of Object.keys(process.env))
    if (/^(FARMSLOT_|GATEWAY_|GIT_CONFIG)/.test(key) || key === 'TMUX' || key === 'TMUX_PANE')
      delete process.env[key];
  Object.assign(process.env, {
    NODE_TEST_CONTEXT: '1',
    GATEWAY_HOST: '127.0.0.1',
    FARMSLOT_ROOT: root,
    FARMSLOT_HOME: path.join(root, 'home'),
    FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
    FARMSLOT_DISABLE_RUN_ENGINE_START: '1',
  });
  for (const dir of ['home', 'pool', 'projects/proof', 'runs', 'scripts', 'services/gateway'])
    await mkdir(path.join(root, dir), { recursive: true });
  await writeFile(
    path.join(root, 'projects/proof/project.json'),
    JSON.stringify({ name: 'proof' }),
  );
  await writeFile(path.join(root, 'CLAUDE.md'), '# Disposable Farmslot proof\n');
  await writeFile(path.join(root, 'scripts/dev.sh'), '#!/bin/sh\n');
  await writeFile(path.join(root, 'services/gateway/package.json'), '{}');
  await symlink(
    fileURLToPath(new URL('../../../../schemas', import.meta.url)),
    path.join(root, 'schemas'),
  );
  await import('../runtime/mock-pty.test-support.js');
  const fixture = await createNativeProofFixture(t, root);
  await import('../methods/run.js');
  const { createRun, updateRun, persistRunNow, readDecisionHistory } =
    await import('../runs/store.js');
  const { runBundleStore } = await import('../run-completion/retained-artifacts.js');
  const { makeReadyGatePackage } = await import('./test-fixtures.js');
  const store = await runBundleStore(true);
  const outcomes = [];
  for (const receipt of ['approval', 'attestation', 'none'] as const) {
    const run = createRun({
      flowType: 'dev',
      project: 'proof',
      ticketOrPr: 'Retired capture proof',
      mode: 'validation',
    });
    const taskDir = path.join(root, 'projects/proof/tasks/dev', run.id);
    await mkdir(path.join(taskDir, 'artifacts'), { recursive: true });
    const bytes = `Retained media bytes for ${receipt}`;
    await writeFile(path.join(taskDir, 'artifacts/recording.mp4'), bytes);
    const captured = await materializeRunBundle({
      store,
      farmslotRoot: root,
      run,
      taskDir,
      artifacts: [
        {
          path: 'artifacts/recording.mp4',
          purpose: 'video',
          sha256: createHash('sha256').update(bytes).digest('hex'),
          sizeBytes: Buffer.byteLength(bytes),
        },
      ],
      manifestDigest: receipt,
      captureKey: receipt,
      commit: async () => {},
    });
    const prepared = makeReadyGatePackage();
    prepared.artifactBundle = captured.ref;
    const retired: RunDecision = {
      id: `gate-${receipt}`,
      type: 'engine_human_gate',
      title: 'Publish',
      description: '',
      actions: [],
      createdAt: run.createdAt,
      resolvedAt: run.updatedAt,
      resolvedAction: 'approve-publish',
      payload: {
        kind: 'ready',
        branch: prepared.branch,
        prNumber: null,
        repo: null,
        workerReport: '',
        diffStat: prepared.diffStat,
        prPackage: prepared,
      },
    };
    if (receipt === 'approval')
      retired.publicationApproval = {
        principalId: fixture.person.id,
        displayName: 'Proof operator',
        subjectKind: 'person',
        packageHash: prepared.packageHash,
        visualJudgmentReceiptIds: [],
        claimOverrideReceiptIds: [],
        approvedAt: run.updatedAt,
      };
    if (receipt === 'attestation')
      retired.evidenceAttestation = {
        schemaVersion: 1,
        runId: run.id,
        decisionId: retired.id,
        packageHash: prepared.packageHash,
        selectedEvidenceKeys: [],
        approver: {
          principalId: fixture.person.id,
          displayName: 'Proof operator',
          credentialId: 'fixture-credential',
        },
        reason: 'Inspected retained media.',
        approvedAt: run.updatedAt,
        waivedReasons: [],
      };
    updateRun(run.id, { status: 'done', decisions: [retired] });
    await persistRunNow(updateRun(run.id, { decisions: [] }));
    const readback = await fixture.client.call<{ run: Run }>(Methods.RUN_GET, {
      runId: run.id,
      view: 'snapshot',
    });
    assert.equal(readback.run.decisions.length, 0);
    assert.equal(readback.run.decisionHistoryCount, 1);
    assert.equal(JSON.stringify(readDecisionHistory(run.id)), JSON.stringify([retired]));
    if (receipt === 'attestation') {
      await fixture.client.call(Methods.RUN_ARCHIVE, { runId: run.id });
      assert.equal(JSON.stringify(readDecisionHistory(run.id)), JSON.stringify([retired]));
    }
    await rm(taskDir, { recursive: true });
    const now = Date.now() + 31 * 86_400_000;
    const selected = (await runBundleHousekeepingPaths(store, now)).some(
      (entry) =>
        entry.store === 'run-bundles' && path.basename(entry.path) === captured.ref.bundleDigest,
    );
    assert.equal(selected, receipt === 'none');
    await collectRunBundleGarbage(store, undefined, now);
    if (receipt === 'none') {
      await assert.rejects(readRetainedRunBundle(store, captured.ref, run.id), { code: 'ENOENT' });
    } else {
      const bundle = await readRetainedRunBundle(store, captured.ref, run.id);
      assert.equal(await bundle.readText('artifacts/recording.mp4'), bytes);
    }
    outcomes.push({
      receipt,
      archived: receipt === 'attestation',
      selected,
      mediaRetained: receipt !== 'none',
    });
  }
  await writeFile(
    path.join(output, 'proof.json'),
    JSON.stringify(
      { status: 'pass', target: 'isolated', modelCalls: 0, farmDispatches: 0, outcomes },
      null,
      2,
    ) + '\n',
  );
});
