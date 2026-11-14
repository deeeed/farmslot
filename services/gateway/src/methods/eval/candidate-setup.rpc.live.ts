// Opt-in protocol proof. All projects, credentials and runs live in a disposable root.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { EvalExperimentManifest, EvalTrialStartResult } from '@farmslot/protocol';

test('eval RPC freezes the configured default and rejects a stale repeated strategy', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'eval-candidate-rpc-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  Object.assign(process.env, {
    FARMSLOT_ROOT: root,
    FARMSLOT_HOME: path.join(root, 'home'),
    FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
    FARMSLOT_POOL_DIR: path.join(root, 'pool'),
    FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
    FARMSLOT_NATIVE_STATE_DIR: path.join(root, 'native'),
    FARMSLOT_DISABLE_RUN_ENGINE_START: '1',
    FARMSLOT_DISABLE_ORCHESTRATION: '1',
    NODE_TEST_CONTEXT: '1',
  });
  delete process.env.TMUX;
  for (const dir of [
    'scripts',
    'services/gateway',
    'pool',
    'home',
    'projects/proof/catalog/fix-bug',
  ])
    await mkdir(path.join(root, dir), { recursive: true });
  await writeFile(path.join(root, 'CLAUDE.md'), '# Disposable eval proof\n');
  await writeFile(path.join(root, 'scripts/dev.sh'), '#!/bin/sh\n');
  await writeFile(path.join(root, 'services/gateway/package.json'), '{}');
  await writeFile(
    path.join(root, 'projects/proof/project.json'),
    JSON.stringify({
      name: 'proof',
      execution_templates: {
        sources: [{ id: 'package:synthetic', kind: 'package', root: { projectPath: 'catalog' } }],
        defaults: [{ when: { flow: 'fix-bug' }, templateId: 'fix-bug/mobile' }],
      },
    }),
  );
  const templateFile = path.join(root, 'projects/proof/catalog/fix-bug/mobile.md');
  const markdown = '# Synthetic fix\n\n- [ ] Check the example behavior.\n';
  await writeFile(templateFile, markdown);
  await import('../../runtime/mock-pty.test-support.js');
  const { GatewayClient } = await import('../../../../../packages/cli/src/gateway-client.js');
  const { createGatewayAuthRuntime } = await import('../../security/auth.js');
  const { createWebSocketServer, disposeServerResourceObservations } =
    await import('../../server.js');
  const { makeEvalResultPackage } = await import('../../run-engine/test-fixtures.js');
  const { writeResultPackageManifest, writeEvalExperimentManifest } =
    await import('../../evals/package-store.js');
  const auth = createGatewayAuthRuntime({ FARMSLOT_HOME: path.join(root, 'home') });
  const principal = auth.writer.createPrincipal({ type: 'service', displayName: 'eval-proof' }, [
    { role: 'admin', scope: { kind: 'global' } },
  ]);
  const credential = auth.writer.issueCredential(principal.id, 'Disposable eval proof');
  const server = createServer();
  const wss = createWebSocketServer(server, auth);
  t.after(async () => {
    for (const socket of wss.clients) socket.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    disposeServerResourceObservations();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const client = new GatewayClient({
    url: `ws://127.0.0.1:${address.port}`,
    timeout: 10_000,
    credential: { token: credential.secret },
  });
  const artifacts = path.join(root, 'experiment/artifacts');
  await mkdir(artifacts, { recursive: true });
  const baseSha = 'a'.repeat(40),
    headSha = 'b'.repeat(40);
  await writeFile(
    path.join(artifacts, 'reference.diff'),
    'diff --git a/value.ts b/value.ts\n--- a/value.ts\n+++ b/value.ts\n@@ -1 +1 @@\n-old\n+fixed\n',
  );
  const referencePackagePath = path.join(artifacts, 'reference.json');
  const reference = await writeResultPackageManifest(
    referencePackagePath,
    makeEvalResultPackage({
      project: 'proof',
      role: 'reference',
      source: { kind: 'git-ref', ref: 'main', baseSha, headSha },
      diff: {
        source: 'artifact',
        available: true,
        files: 1,
        additions: 1,
        deletions: 1,
        kind: 'contribution',
        baseSha,
        headSha,
        artifactPath: 'artifacts/reference.diff',
      },
    }),
  );
  const manifest: EvalExperimentManifest = {
    version: 1,
    kind: 'eval-experiment',
    experimentId: 'synthetic-eval',
    experimentKey: 'synthetic-key',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    project: 'proof',
    familyId: 'synthetic-family',
    case: {
      caseId: 'synthetic-case',
      taskProfile: 'fix-bug',
      source: reference.source,
      objectiveHash: 'synthetic-objective',
      problemStatement:
        'Correct the example behavior.\n\nAcceptance criteria:\n- First authored criterion.\n- Second authored criterion.\n- Third authored criterion.',
      referencePackageId: reference.packageId,
      referencePackageHash: reference.packageHash,
      referencePackagePath,
    },
    rubric: {
      taskProfile: 'fix-bug',
      rubricId: 'eval-default',
      rubricVersion: '1',
      requiredEvidence: [],
    },
    candidateStrategies: [],
    trials: [],
    missingData: [],
  };
  const experimentManifestPath = path.join(artifacts, 'experiment.json');
  await writeEvalExperimentManifest(experimentManifestPath, manifest);
  // The serialized default Command Center trial payload omits axes.template.
  const params = {
    project: 'proof',
    experimentManifestPath,
    axes: {
      prompt: { name: 'fix-bug' },
      harness: { name: 'recipe-harness' },
      review: { name: 'none', version: 'first-pass' },
      runner: { name: 'codex' },
      model: { name: 'comparison-model' },
    },
    runner: 'codex',
    model: 'comparison-model',
  };
  const first = await client.call<EvalTrialStartResult>('eval.trial.start', params);
  assert.ok(first.run);
  const criteria = [
    'First authored criterion.',
    'Second authored criterion.',
    'Third authored criterion.',
  ];
  assert.deepEqual(first.run.ticketData?.acceptanceCriteria, criteria);
  const frozen = first.run.executionTemplate;
  assert.equal(frozen?.relativePath, 'fix-bug/mobile.md');
  assert.equal(first.candidatePackage.axes.template?.hash, frozen?.sha256);
  assert.equal(first.candidatePackage.templateProvenance?.contentHash, frozen?.sha256);
  const inputs = path.join(
    path.dirname(path.dirname(path.dirname(first.candidatePackagePath))),
    'inputs',
  );
  assert.equal(await readFile(path.join(inputs, 'candidate-template.md'), 'utf8'), markdown);
  const repeated = await client.call<EvalTrialStartResult>('eval.trial.start', {
    ...params,
    axes: first.candidatePackage.axes,
    repeat: true,
  });
  assert.equal(repeated.candidatePackage.axes.template?.hash, frozen?.sha256);
  // An experiment-local file is admitted without becoming a project catalog entry.
  const localFile = path.join(artifacts, 'B1.core.md');
  const candidateMarkdown = '# Local B1\n\n- [ ] Use only the admitted experiment bytes.\n';
  await writeFile(localFile, candidateMarkdown);
  const local = await client.call<EvalTrialStartResult>('eval.trial.start', {
    ...params,
    candidateTemplatePath: 'B1.core.md',
    trialId: 'local-B1',
    review: false,
  });
  assert.ok(local.run?.engineState?.evalExperiment?.candidateTemplate);
  const snapshot = local.run.engineState.evalExperiment.candidateTemplate;
  assert.equal(local.candidatePackage.axes.template?.hash, snapshot.reference.sha256);
  assert.equal(local.candidatePackage.templateProvenance?.contentHash, snapshot.reference.sha256);
  assert.equal(await readFile(snapshot.path, 'utf8'), candidateMarkdown);
  await unlink(localFile);
  const { loadProjectVars } = await import('../../core/config.js');
  const { resolveConfiguredExecutionTemplateForSlot } =
    await import('../../tasks/execution-template-catalog.js');
  const vars = await loadProjectVars('proof');
  const slotQuery = { flow: 'fix-bug', platform: 'core', runMode: 'autonomous' as const };
  const selected = await resolveConfiguredExecutionTemplateForSlot(vars, {
    ...slotQuery,
    candidateTemplate: snapshot,
  });
  assert.equal(selected.markdown, candidateMarkdown);
  assert.deepEqual(selected.reference.platforms, ['core']);
  await assert.rejects(
    resolveConfiguredExecutionTemplateForSlot(vars, {
      ...slotQuery,
      platform: 'ios',
      candidateTemplate: snapshot,
    }),
    /incompatible/,
  );
  assert.equal(selected.reference.sha256, local.candidatePackage.axes.template?.hash);
  assert.equal(
    (await resolveConfiguredExecutionTemplateForSlot(vars, slotQuery)).reference.sha256,
    frozen?.sha256,
  );
  const result = await client.call<{ candidatePackage: EvalTrialStartResult['candidatePackage'] }>(
    'eval.trial.result.get',
    { runId: local.run.id },
  );
  assert.equal(result.candidatePackage.axes.template?.hash, snapshot.reference.sha256);
  const before = await readFile(experimentManifestPath, 'utf8');
  await writeFile(templateFile, markdown + '\nChanged package bytes.\n');
  await assert.rejects(
    client.call('eval.trial.start', {
      ...params,
      axes: first.candidatePackage.axes,
      repeat: true,
    }),
    /Candidate template hash mismatch.*expected.*resolved/,
  );
  assert.equal(
    await readFile(experimentManifestPath, 'utf8'),
    before,
    'A rejected repeat must not add a trial or rewrite its recorded strategy.',
  );
});
