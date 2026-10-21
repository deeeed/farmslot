import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import type { ArtifactRef, RecipeArtifactManifestEntry, Run } from '@farmslot/protocol';

await import('../runtime/mock-pty.test-support.js');
const { readFrozenRecordedEvidenceSources, readGateRecordedEvidenceSources } =
  await import('../run-engine/recorded-evidence-sources.js');
const { buildPackageEvidenceManifest } = await import('./package-evidence-manifest.js');
const { readFrozenPublicationManifest, verifyFrozenPublicationEvidence } =
  await import('./recorded-publication-evidence.js');
const { allSelectedEvidenceKeysForPublication, assertPublicationEvidenceSelection } =
  await import('./publication-evidence-policy.js');
const { expandPublicationEvidenceSelection, readEvidenceManifest } =
  await import('./publication-artifacts.js');
const { publicationBaselineContext } = await import('./publication-artifacts.js');
const { computeReadyGatePackageHash } = await import('./ready-gate-package.js');

const { makeRun, makeReadyGatePackage, retainRunFixture, overwriteRetainedFixture } =
  await import('../run-engine/test-fixtures.js');

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

test('a publication with no retained evidence needs no invented artifact directory', async () => {
  await verifyFrozenPublicationEvidence({ id: 'no-evidence' } as Run, [], []);
  await assert.rejects(
    verifyFrozenPublicationEvidence(
      { id: 'missing-evidence' } as Run,
      [{ path: 'artifacts/proof.png', purpose: 'screenshot' }],
      ['artifacts/proof.png'],
    ),
    /requires a task directory/,
  );
});

test('selected standalone metadata cannot disclose a credential through its file name', async () => {
  const file = `artifacts/ghp_${'x'.repeat(36)}.png`;
  await assert.rejects(
    verifyFrozenPublicationEvidence(
      makeRun({ taskFile: null }),
      [{ path: file, purpose: 'screenshot' }],
      ['proof.png', file],
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Publication blocked by secret values: github-token sha256:/);
      assert.ok(!error.message.includes(file));
      return true;
    },
  );
});

async function indexFixtureArtifact(
  root: string,
  filename: string,
  type: RecipeArtifactManifestEntry['type'] = 'screenshot',
) {
  const manifestPath = path.join(root, 'artifact-manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.artifacts.push({ path: filename, type, label: 'Captured artifact' });
  await writeFile(manifestPath, JSON.stringify(manifest));
}

async function fixture(t: TestContext) {
  const taskDir = await mkdtemp(path.join(os.tmpdir(), 'recorded-publication-'));
  t.after(() => rm(taskDir, { recursive: true, force: true }));
  const root = path.join(taskDir, 'artifacts/recipe-run');
  await mkdir(root, { recursive: true });
  await cp(
    new URL(
      '../../../../docs/examples/recipes/farmslot/artifacts/provenance-smoke/',
      import.meta.url,
    ),
    root,
    { recursive: true },
  );
  await writeFile(path.join(root, 'proof.png'), 'captured HUD image');
  await indexFixtureArtifact(root, 'proof.png');
  const manifest = {
    version: 1,
    standalone: [{ label: 'Observed claim', file: 'recipe-run/proof.png' }],
  };
  await writeFile(path.join(taskDir, 'artifacts/evidence-manifest.json'), JSON.stringify(manifest));
  const artifacts: ArtifactRef[] = await Promise.all(
    (await readdir(root)).map(async (file) => ({
      path: `artifacts/recipe-run/${file}`,
      purpose: file === 'proof.png' ? 'screenshot' : 'other',
      sha256: digest(await readFile(path.join(root, file))),
    })),
  );
  const run = makeRun({ id: randomUUID(), taskFile: path.join(taskDir, 'TASK.md') });
  return { taskDir, root, run, artifacts, manifest };
}

test('finished capture registers its generated publication selection before strict reads', async (t) => {
  const { taskDir } = await fixture(t);
  const { createRun, deleteRun, getRun, updateRun } = await import('../runs/store.js');
  const { captureRunOutput } = await import('./output.js');
  const { readCurrentPackageEvidence } = await import('./package-evidence-manifest.js');
  const { readRetainedRunText, retainedRunArtifactManifest } =
    await import('./retained-artifacts.js');
  const run = createRun({
    flowType: 'pr-complete',
    project: 'selection-retention-fixture',
    ticketOrPr: 'fixture/core#10855',
  });
  t.after(async () => {
    updateRun(run.id, { status: 'done', completedAt: new Date().toISOString() });
    await deleteRun(run.id);
  });
  updateRun(run.id, {
    taskFile: path.join(taskDir, 'TASK.md'),
    status: 'completing',
    recordedEvidenceContractVersion: 0,
  });
  await captureRunOutput(run.id, false, true);
  const captured = getRun(run.id)!;
  const evidence = await readCurrentPackageEvidence(captured);
  const selection = evidence.inventory.find((entry) =>
    entry.path.startsWith('artifacts/pr-package-evidence/'),
  );
  assert.ok(selection);
  assert.ok(
    captured.output?.artifactManifest.some((entry) => entry.path === selection.path),
    'The generated selection belongs to the captured output inventory',
  );
  assert.ok(
    (await retainedRunArtifactManifest(captured)).some((entry) => entry.path === selection.path),
    'The immutable bundle manifest indexes the generated selection',
  );
  assert.equal(
    digest(Buffer.from(await readRetainedRunText(captured, selection.path))),
    selection.sha256,
  );
  await verifyFrozenPublicationEvidence(captured, evidence.inventory, [
    'artifacts/recipe-run/proof.png',
  ]);
  await captureRunOutput(run.id, false, true);
  const replayed = getRun(run.id)!;
  const replayEvidence = await readCurrentPackageEvidence(replayed);
  await verifyFrozenPublicationEvidence(replayed, replayEvidence.inventory, [
    'artifacts/recipe-run/proof.png',
  ]);
});

test('frozen indexed text is scanned without changing bytes or admitting historical packages', async (t) => {
  const { taskDir, root, run, artifacts, manifest } = await fixture(t);
  // The published all-zero-entropy BIP-39 test vector: checksum-valid, never a wallet.
  const phrase = [...Array<string>(11).fill('abandon'), 'about'].join(' ');
  const log = path.join(root, 'observed.log');
  await writeFile(log, JSON.stringify({ arbitrary: phrase }));
  await indexFixtureArtifact(root, 'observed.log', 'log');
  artifacts.push({ path: 'artifacts/recipe-run/observed.log', purpose: 'other' });
  const inventory = await buildPackageEvidenceManifest(taskDir, artifacts, manifest);
  await retainRunFixture(run);
  const frozen = await readFile(log);
  await assert.rejects(
    verifyFrozenPublicationEvidence(run, inventory, ['artifacts/recipe-run/proof.png']),
    /Publication blocked by secret values: srp sha256:/,
  );
  assert.deepEqual(await readFile(log), frozen);
  // A new clean capture is a new fixture, never an edit to the refused package.
  const clean = await fixture(t);
  await mkdir(path.join(clean.taskDir, 'artifacts/historical'));
  await writeFile(path.join(clean.taskDir, 'artifacts/historical/old.log'), phrase);
  const cleanInventory = await buildPackageEvidenceManifest(
    clean.taskDir,
    clean.artifacts,
    clean.manifest,
  );
  cleanInventory.push({
    path: 'artifacts/historical/old.log',
    purpose: 'evidence-dependency',
    sha256: digest(Buffer.from(phrase)),
  });
  await retainRunFixture(clean.run);
  await verifyFrozenPublicationEvidence(clean.run, cleanInventory, [
    'artifacts/recipe-run/proof.png',
  ]);
});

// Gate readers that leave only the publication secret scan live.
const gateReaders = {
  deterministic: async () => {},
  acceptance: async () => ({ criteria: [], ledger: null, issues: [] }),
  progress: async () => ({ kind: 'idle' as const }),
  selectedEvidence: async () => {},
  reviewResult: async () => undefined,
};

// TAT-4145 bda11b1a: the selected recording's frozen recipe text carried a secret-shaped
// value, the gate read ready, and publication refused at finalize.
test('the publication gate refuses the frozen evidence text publication would refuse', async (t) => {
  const { collectRunGateReadiness } = await import('../run-engine/gate-prerequisites.js');
  const { taskDir, root, run, artifacts, manifest } = await fixture(t);
  await writeFile(
    path.join(root, 'observed.log'),
    JSON.stringify({ arbitrary: [...Array<string>(11).fill('abandon'), 'about'].join(' ') }),
  );
  await indexFixtureArtifact(root, 'observed.log', 'log');
  artifacts.push({ path: 'artifacts/recipe-run/observed.log', purpose: 'other' });
  const inventory = await buildPackageEvidenceManifest(taskDir, artifacts, manifest);
  await retainRunFixture(run);
  const readiness = await collectRunGateReadiness(
    run,
    makeReadyGatePackage({
      evidenceManifest: inventory,
      selectedEvidenceKeys: ['artifacts/recipe-run/proof.png'],
      reviewPolicy: { minimumReviews: 0, requestedBy: 'dispatch' },
    }),
    gateReaders,
  );
  assert.equal(readiness.state, 'not-ready');
  const reason = readiness.reasons.find(({ code }) => code === 'publication-secret-values');
  assert.match(reason?.message ?? '', /Publication blocked by secret values: srp sha256:/);
});

test('the publication gate reads clean frozen evidence text as clean', async (t) => {
  const { collectRunGateReadiness } = await import('../run-engine/gate-prerequisites.js');
  const { taskDir, run, artifacts, manifest } = await fixture(t);
  const inventory = await buildPackageEvidenceManifest(taskDir, artifacts, manifest);
  await retainRunFixture(run);
  const readiness = await collectRunGateReadiness(
    run,
    makeReadyGatePackage({
      evidenceManifest: inventory,
      selectedEvidenceKeys: ['artifacts/recipe-run/proof.png'],
      reviewPolicy: { minimumReviews: 0, requestedBy: 'dispatch' },
    }),
    gateReaders,
  );
  assert.deepEqual(
    readiness.reasons.filter(
      ({ code, message }) =>
        code === 'publication-secret-values' ||
        message.startsWith('The publication secret scan could not read'),
    ),
    [],
  );
});

test('a declared empty diagnostic log remains valid publication evidence', async (t) => {
  const { taskDir, root, run, artifacts, manifest } = await fixture(t);
  await writeFile(path.join(root, 'diagnostics-app-log.txt'), '');
  await indexFixtureArtifact(root, 'diagnostics-app-log.txt', 'log');
  artifacts.push({ path: 'artifacts/recipe-run/diagnostics-app-log.txt', purpose: 'other' });
  const inventory = await buildPackageEvidenceManifest(taskDir, artifacts, manifest);
  await retainRunFixture(run);
  await verifyFrozenPublicationEvidence(run, inventory, ['artifacts/recipe-run/proof.png']);
});

test('selected evidence retains labelled comparisons and external captures with frozen declarations', async (t) => {
  const { taskDir, root, run, artifacts } = await fixture(t);
  const selected = path.join(taskDir, 'artifacts/recipe-runs/current');
  await mkdir(path.dirname(selected), { recursive: true });
  await rename(root, selected);
  for (const artifact of artifacts)
    artifact.path = artifact.path.replace('recipe-run/', 'recipe-runs/current/');
  run.recordedEvidenceContractVersion = 1;
  await writeFile(path.join(taskDir, 'artifacts/baseline.png'), 'non-recipe baseline');
  artifacts.push({ path: 'artifacts/baseline.png', purpose: 'screenshot' });
  await writeFile(
    path.join(selected, 'evidence-manifest.json'),
    JSON.stringify({
      version: 1,
      standalone: [{ label: 'Engine capture', file: 'proof.png' }],
    }),
  );
  await writeFile(
    path.join(taskDir, 'artifacts/latest-valid-recipe-run.json'),
    JSON.stringify({
      version: 1,
      relativeArtifactRoot: 'recipe-runs/current',
    }),
  );
  const declarationsPath = path.join(taskDir, 'artifacts/evidence-manifest.json');
  await writeFile(
    declarationsPath,
    JSON.stringify({
      version: 1,
      before_after_pairs: [
        {
          label: 'Flag off / flag on',
          covers: ['AC-1'],
          before: 'baseline.png',
          after: 'recipe-runs/current/proof.png',
        },
      ],
      videos: { preferred: false, note: 'Use the comparison stills.' },
      before_state_capture: { source: 'baseline' },
    }),
  );
  await retainRunFixture(run);
  const effective = await readEvidenceManifest(run);
  assert.equal(effective?.before_after_pairs?.[0]?.label, 'Flag off / flag on');
  assert.deepEqual(effective?.standalone, []);
  assert.equal(effective?.videos?.note, 'Use the comparison stills.');
  assert.equal(effective?.before_state_capture?.source, 'baseline');
  const inventory = await buildPackageEvidenceManifest(taskDir, artifacts, effective);
  assert(
    inventory.some(
      (entry) =>
        entry.path === 'artifacts/evidence-manifest.json' &&
        entry.purpose === 'evidence-manifest-source',
    ),
  );
  assert(inventory.some((entry) => entry.path === 'artifacts/baseline.png' && entry.sha256));
  assert.deepEqual(
    expandPublicationEvidenceSelection({
      selectedEvidenceKeys: ['artifacts/recipe-runs/current/proof.png'],
      evidenceManifest: inventory,
      trustedEvidenceManifest: effective,
    }),
    ['artifacts/baseline.png', 'artifacts/recipe-runs/current/proof.png'],
  );
  const prepared = makeReadyGatePackage({
    id: 'comparison',
    evidenceManifest: inventory,
    selectedEvidenceKeys: ['artifacts/baseline.png', 'artifacts/recipe-runs/current/proof.png'],
  });
  prepared.packageHash = computeReadyGatePackageHash(prepared);
  await retainRunFixture(run);
  assert.equal(
    (await readGateRecordedEvidenceSources(run, prepared))[0]?.artifactPrefix,
    'artifacts/recipe-runs/current/',
  );
  assert.deepEqual(
    await readFrozenPublicationManifest(run, inventory),
    JSON.parse(JSON.stringify(effective)),
  );
  await verifyFrozenPublicationEvidence(run, inventory, prepared.selectedEvidenceKeys!);
  await overwriteRetainedFixture(
    run,
    path.relative(taskDir, declarationsPath),
    JSON.stringify({ version: 1, standalone: [] }),
  );
  await assert.rejects(readFrozenPublicationManifest(run, inventory), /hash mismatch/);
});

test('task declarations cannot select a retained artifact owned by another recipe attempt', async (t) => {
  const { taskDir, root, run } = await fixture(t);
  run.recordedEvidenceContractVersion = 1;
  const selected = path.join(taskDir, 'artifacts/recipe-runs/current');
  await mkdir(path.dirname(selected), { recursive: true });
  await rename(root, selected);
  await writeFile(
    path.join(selected, 'evidence-manifest.json'),
    JSON.stringify({ version: 1, standalone: [] }),
  );
  await writeFile(
    path.join(taskDir, 'artifacts/latest-valid-recipe-run.json'),
    JSON.stringify({ version: 1, relativeArtifactRoot: 'recipe-runs/current' }),
  );
  await mkdir(path.join(taskDir, 'artifacts/previous'));
  await writeFile(
    path.join(taskDir, 'artifacts/previous/artifact-manifest.json'),
    JSON.stringify({
      version: 1,
      artifacts: [{ path: 'before.png', type: 'screenshot' }],
    }),
  );
  await writeFile(
    path.join(taskDir, 'artifacts/evidence-manifest.json'),
    JSON.stringify({
      version: 1,
      before_after_pairs: [
        {
          label: 'Comparison',
          before: 'previous/before.png',
          after: 'recipe-runs/current/proof.png',
        },
      ],
    }),
  );
  await retainRunFixture(run);
  await assert.rejects(readEvidenceManifest(run), (error: unknown) => {
    assert.equal((error as { code: string }).code, 'evidence-selection-invalid');
    assert.match((error as Error).message, /belongs to another recipe attempt/);
    return true;
  });
});

async function baselineFixture(t: TestContext, baselineLog?: string) {
  const { createRecipeRunner, createStandardCoreAdapters, readRecordedEvidencePackage } =
    await import('@farmslot/recipe-runner');
  const { buildRunRecord } = await import('../runs/store.js');
  const taskDir = await mkdtemp(path.join(os.tmpdir(), 'baseline-publication-'));
  t.after(() => rm(taskDir, { recursive: true, force: true }));
  const baselineRoot = 'recipe-baseline-run';
  const headRoot = 'recipe-runs/current';
  const { RECIPE_ACTION_MANIFEST_SCHEMA_URL } = await import('@farmslot/protocol');
  const runner = createRecipeRunner({
    actionManifest: {
      $schema: RECIPE_ACTION_MANIFEST_SCHEMA_URL,
      actions: {
        command: {
          description: 'Read a value.',
          schema: {
            type: 'object',
            properties: { cmd: { type: 'string' } },
            additionalProperties: false,
          },
          examples: [
            { action: 'command', cmd: 'printf observed', intent: 'Read the value.', next: 'check' },
          ],
        },
        assert_output: {
          description: 'Assert a value.',
          schema: {
            type: 'object',
            properties: { source: { type: 'string' }, contains: { type: 'string' } },
            additionalProperties: false,
          },
          examples: [
            {
              action: 'assert_output',
              source: 'read',
              contains: 'observed',
              intent: 'Check the value.',
              next: 'done',
            },
          ],
        },
        end: { description: 'Finish.', examples: [{ action: 'end', status: 'pass' }] },
      },
    },
    adapters: createStandardCoreAdapters({ actions: ['command', 'assert_output'] }),
    hud: false,
    defaultSource: { kind: 'operator', trust: 'trusted' },
  });
  const recipe = (value: string) => ({
    $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
    title: 'Observe the changed value',
    description: 'Keep baseline failure separate from head proof.',
    proofTargets: [{ id: 'AC-1', claim: 'The value is observed.', proofMode: 'state' }],
    workflow: {
      entry: 'read',
      nodes: {
        read: {
          action: 'command',
          cmd: `printf ${value}`,
          intent: 'Read the value.',
          next: 'check',
        },
        check: {
          action: 'assert_output',
          source: 'read',
          contains: 'observed',
          proves: ['AC-1'],
          intent: 'Check the value.',
          next: 'done',
        },
        done: { action: 'end', status: 'pass' },
      },
    },
  });
  const baseline = await runner.run({
    projectRoot: taskDir,
    artifactsDir: path.join(taskDir, 'artifacts', baselineRoot),
    recipeDocument: recipe('defect'),
  });
  const head = await runner.run({
    projectRoot: taskDir,
    artifactsDir: path.join(taskDir, 'artifacts', headRoot),
    recipeDocument: recipe('observed'),
  });
  const baseSha = 'a'.repeat(40);
  const branch = 'feature';
  const provenance = { schemaVersion: 1, git_ref: baseSha, dirty: false, branch };
  for (const root of [baselineRoot, headRoot]) {
    const dir = path.join(taskDir, 'artifacts', root);
    await writeFile(path.join(dir, 'proof.png'), `capture ${root}`);
    await indexFixtureArtifact(dir, 'proof.png');
    if (root === baselineRoot) {
      if (baselineLog !== undefined) {
        await writeFile(path.join(dir, 'diagnostics-app-log.txt'), baselineLog);
        await indexFixtureArtifact(dir, 'diagnostics-app-log.txt', 'log');
      }
      await writeFile(path.join(dir, 'product-provenance.json'), JSON.stringify(provenance));
      const filename = path.join(dir, 'artifact-manifest.json');
      const manifest = JSON.parse(await readFile(filename, 'utf8'));
      manifest.artifacts.push({
        path: 'product-provenance.json',
        type: 'json',
        category: 'system',
      });
      await writeFile(filename, JSON.stringify(manifest));
    }
  }
  await writeFile(
    path.join(taskDir, 'artifacts', headRoot, 'evidence-manifest.json'),
    JSON.stringify({ version: 1, standalone: [{ label: 'Head proof', file: 'proof.png' }] }),
  );
  await writeFile(
    path.join(taskDir, 'artifacts/latest-valid-recipe-run.json'),
    JSON.stringify({ version: 1, relativeArtifactRoot: headRoot }),
  );
  const declaration = {
    version: 1,
    before_after_pairs: [
      {
        label: 'Changed value',
        covers: ['AC-1'],
        before: `${baselineRoot}/proof.png`,
        after: `${headRoot}/proof.png`,
      },
    ],
  };
  const declarationPath = path.join(taskDir, 'artifacts/evidence-manifest.json');
  await writeFile(declarationPath, JSON.stringify(declaration));
  const inventory: ArtifactRef[] = [];
  for (const root of [baselineRoot, headRoot]) {
    const read = await readRecordedEvidencePackage(path.join(taskDir, 'artifacts', root));
    assert(read.checks.every((check) => check.status === 'pass'));
    for (const file of read.input.artifactPaths ?? [])
      inventory.push({
        path: `artifacts/${root}/${file}`,
        purpose: file === 'proof.png' ? 'screenshot' : 'other',
        sha256: read.input.artifactDigests[file],
      });
  }
  const run = buildRunRecord({ project: 'baseline-proof', flowType: 'dev', ticketOrPr: 'TEST-1' });
  Object.assign(run, {
    taskFile: path.join(taskDir, 'TASK.md'),
    branch,
    worktreeHeadAtDispatch: baseSha,
    recordedEvidenceContractVersion: 1,
  });
  run.output = {
    workerFinished: true,
    capturedAt: new Date().toISOString(),
    manifestDigest: digest(Buffer.from(JSON.stringify(inventory))),
    artifactManifest: inventory,
  };
  return {
    taskDir,
    run,
    inventory,
    baseline,
    head,
    provenance,
    declaration,
    declarationPath,
    baselineRoot,
    headRoot,
  };
}

test('a first finished capture uses its new inventory to register same-run baseline selection', async (t) => {
  const f = await baselineFixture(t);
  const { createRun, deleteRun, getRun, updateRun } = await import('../runs/store.js');
  const { captureRunOutput } = await import('./output.js');
  const { readCurrentPackageEvidence } = await import('./package-evidence-manifest.js');
  const { readRetainedRunText } = await import('./retained-artifacts.js');
  const run = createRun({ flowType: 'dev', project: 'baseline-proof', ticketOrPr: 'TEST-CAPTURE' });
  t.after(async () => {
    updateRun(run.id, { status: 'done', completedAt: new Date().toISOString() });
    await deleteRun(run.id);
  });
  updateRun(run.id, {
    taskFile: f.run.taskFile,
    status: 'completing',
    branch: f.run.branch,
    worktreeHeadAtDispatch: f.run.worktreeHeadAtDispatch,
    recordedEvidenceContractVersion: 1,
  });
  assert.equal(getRun(run.id)?.output, undefined);
  await captureRunOutput(run.id, false, true);
  const captured = getRun(run.id)!;
  const current = await readCurrentPackageEvidence(captured);
  const selection = current.inventory.find((entry) =>
    entry.path.startsWith('artifacts/pr-package-evidence/'),
  );
  assert.ok(selection);
  assert.equal(
    digest(Buffer.from(await readRetainedRunText(captured, selection.path))),
    selection.sha256,
  );
});

test('failed output remains retained when the selected recipe manifest is missing', async (t) => {
  const { taskDir } = await fixture(t);
  await mkdir(path.join(taskDir, 'artifacts/recipe-runs/missing'), { recursive: true });
  await writeFile(path.join(taskDir, 'artifacts/report.md'), '# Failed recipe diagnostics\n');
  await writeFile(
    path.join(taskDir, 'artifacts/latest-valid-recipe-run.json'),
    JSON.stringify({ version: 1, relativeArtifactRoot: 'recipe-runs/missing' }),
  );
  const { createRun, deleteRun, getRun, updateRun } = await import('../runs/store.js');
  const { captureRunOutput } = await import('./output.js');
  const { readCurrentPackageEvidence } = await import('./package-evidence-manifest.js');
  const { readRetainedRunText } = await import('./retained-artifacts.js');
  const run = createRun({ flowType: 'dev', project: 'raw-capture', ticketOrPr: 'FAILED-CAPTURE' });
  t.after(async () => {
    await deleteRun(run.id);
  });
  updateRun(run.id, {
    taskFile: path.join(taskDir, 'TASK.md'),
    status: 'failed',
    completedAt: new Date().toISOString(),
    recordedEvidenceContractVersion: 1,
  });
  await captureRunOutput(run.id, false, true);
  const captured = getRun(run.id)!;
  assert.equal(
    await readRetainedRunText(captured, 'artifacts/report.md'),
    '# Failed recipe diagnostics\n',
  );
  await assert.rejects(
    readCurrentPackageEvidence(captured),
    (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'evidence-selection-missing',
  );
});

test('same-run clean baseline freezes as before evidence without supplying head verdicts', async (t) => {
  const f = await baselineFixture(t);
  assert.equal(f.baseline.claims.criteria[0]?.verdict, 'failed');
  assert.equal(f.head.claims.criteria[0]?.verdict, 'proven');
  await retainRunFixture(f.run);
  const effective = await readEvidenceManifest(f.run);
  const inventory = await buildPackageEvidenceManifest(
    f.taskDir,
    f.inventory,
    effective,
    1,
    publicationBaselineContext(f.run),
  );
  assert(
    inventory.some(
      (entry) => entry.path === `artifacts/${f.baselineRoot}/trace.json` && entry.sha256,
    ),
  );
  const keys = [`artifacts/${f.baselineRoot}/proof.png`, `artifacts/${f.headRoot}/proof.png`];
  const { readFrozenPublicationRecipeSources } =
    await import('../run-engine/recorded-evidence-sources.js');
  await retainRunFixture(f.run);
  const sources = await readFrozenPublicationRecipeSources(f.run, inventory, keys);
  assert.equal(sources.length, 1);
  assert.equal(sources[0]?.input.claims?.recipeRunId, f.head.claims.recipeRunId);
  assert.equal(sources[0]?.input.claims?.criteria[0]?.verdict, 'proven');
  // TAT-4145 bda11b1a selected only baseline captures. The publication reader still reads the
  // selected attempt's proof; the selected keys' own roots are only the baseline.
  const baselineOnly = [`artifacts/${f.baselineRoot}/proof.png`];
  const { readFrozenRecordedEvidenceSources } =
    await import('../run-engine/recorded-evidence-sources.js');
  await retainRunFixture(f.run);
  assert.deepEqual(
    (await readFrozenPublicationRecipeSources(f.run, inventory, baselineOnly)).map(
      ({ input }) => input.claims?.recipeRunId,
    ),
    [f.head.claims.recipeRunId],
  );
  await retainRunFixture(f.run);
  assert.deepEqual(
    (await readFrozenRecordedEvidenceSources(f.run, inventory, baselineOnly)).map(
      ({ input }) => input.claims?.recipeRunId,
    ),
    [f.baseline.claims.recipeRunId],
  );
  await assert.rejects(
    readFrozenPublicationRecipeSources(f.run, inventory, [
      `artifacts/${f.baselineRoot}/trace.json`,
    ]),
    /undeclared recipe attempt/,
  );
  await retainRunFixture(f.run);
  await verifyFrozenPublicationEvidence(f.run, inventory, keys);
  await overwriteRetainedFixture(
    f.run,
    `artifacts/${f.baselineRoot}/proof.png`,
    'changed baseline capture',
  );
  await assert.rejects(verifyFrozenPublicationEvidence(f.run, inventory, keys), /hash mismatch/);
});

test('selected baseline text is scanned without promoting baseline verdicts', async (t) => {
  const value = `private_key = ${'1'.repeat(64)}`;
  const f = await baselineFixture(t, value);
  await retainRunFixture(f.run);
  const effective = await readEvidenceManifest(f.run);
  const inventory = await buildPackageEvidenceManifest(
    f.taskDir,
    f.inventory,
    effective,
    1,
    publicationBaselineContext(f.run),
  );
  await retainRunFixture(f.run);
  const keys = [`artifacts/${f.baselineRoot}/proof.png`, `artifacts/${f.headRoot}/proof.png`];
  const { readFrozenPublicationRecipeSources } =
    await import('../run-engine/recorded-evidence-sources.js');
  const sources = await readFrozenPublicationRecipeSources(f.run, inventory, keys);
  assert.equal(sources.length, 1);
  assert.equal(sources[0]?.input.claims?.recipeRunId, f.head.claims.recipeRunId);
  await assert.rejects(
    verifyFrozenPublicationEvidence(f.run, inventory, keys),
    /Publication blocked by secret values: private-key sha256:/,
  );
  assert.equal(
    await readFile(
      path.join(f.taskDir, 'artifacts', f.baselineRoot, 'diagnostics-app-log.txt'),
      'utf8',
    ),
    value,
  );
});

test('the gate scans the pair half publication adds to an after-only selection', async (t) => {
  const { collectRunGateReadiness } = await import('../run-engine/gate-prerequisites.js');
  const f = await baselineFixture(t, `private_key = ${'1'.repeat(64)}`);
  await retainRunFixture(f.run);
  const effective = await readEvidenceManifest(f.run);
  const inventory = await buildPackageEvidenceManifest(
    f.taskDir,
    f.inventory,
    effective,
    1,
    publicationBaselineContext(f.run),
  );
  await retainRunFixture(f.run);
  // Only the head capture is selected; publication uploads its paired baseline too.
  const readiness = await collectRunGateReadiness(
    f.run,
    makeReadyGatePackage({
      evidenceManifest: inventory,
      selectedEvidenceKeys: [`artifacts/${f.headRoot}/proof.png`],
      reviewPolicy: { minimumReviews: 0, requestedBy: 'dispatch' },
    }),
    gateReaders,
  );
  assert.equal(readiness.state, 'not-ready');
  const reason = readiness.reasons.find(({ code }) => code === 'publication-secret-values');
  assert.match(reason?.message ?? '', /Publication blocked by secret values: private-key sha256:/);
});

test('baseline declarations refuse other roles, source changes and incomplete captured closures', async (t) => {
  const f = await baselineFixture(t);
  await writeFile(
    f.declarationPath,
    JSON.stringify({
      version: 1,
      standalone: [{ label: 'Other attempt', file: `${f.baselineRoot}/proof.png` }],
    }),
  );
  await retainRunFixture(f.run);
  await assert.rejects(readEvidenceManifest(f.run), /belongs to another recipe attempt/);
  await writeFile(
    f.declarationPath,
    JSON.stringify({
      ...f.declaration,
      before_after_pairs: f.declaration.before_after_pairs.map((pair) => ({
        ...pair,
        before: pair.after,
        after: pair.before,
      })),
    }),
  );
  await retainRunFixture(f.run);
  await assert.rejects(readEvidenceManifest(f.run), /belongs to another recipe attempt/);
  await writeFile(f.declarationPath, JSON.stringify(f.declaration));
  for (const provenance of [
    { ...f.provenance, dirty: true },
    { ...f.provenance, git_ref: 'b'.repeat(40) },
    { ...f.provenance, branch: 'another-run' },
  ]) {
    const ref = f.inventory.find(
      (entry) => entry.path === `artifacts/${f.baselineRoot}/product-provenance.json`,
    )!;
    ref.sha256 = digest(Buffer.from(JSON.stringify(provenance)));
    await writeFile(
      path.join(f.taskDir, 'artifacts', f.baselineRoot, 'product-provenance.json'),
      JSON.stringify(provenance),
    );
    await retainRunFixture(f.run);
    await assert.rejects(readEvidenceManifest(f.run), /belongs to another recipe attempt/);
  }
  await writeFile(
    path.join(f.taskDir, 'artifacts', f.baselineRoot, 'product-provenance.json'),
    JSON.stringify(f.provenance),
  );
  f.inventory.find(
    (entry) => entry.path === `artifacts/${f.baselineRoot}/product-provenance.json`,
  )!.sha256 = digest(Buffer.from(JSON.stringify(f.provenance)));
  await retainRunFixture(f.run);
  const effective = await readEvidenceManifest(f.run);
  const missing = publicationBaselineContext(
    f.run,
    f.inventory.filter((entry) => entry.path !== `artifacts/${f.baselineRoot}/trace.json`),
  );
  await assert.rejects(
    buildPackageEvidenceManifest(f.taskDir, f.inventory, effective, 1, missing),
    /Baseline closure is missing or changed/,
  );
  await writeFile(path.join(f.taskDir, 'artifacts', f.baselineRoot, 'trace.json'), '{}');
  await assert.rejects(
    buildPackageEvidenceManifest(
      f.taskDir,
      f.inventory,
      effective,
      1,
      publicationBaselineContext(f.run),
    ),
    /closure is invalid|Baseline closure is missing or changed/,
  );
});

test('selected recorded media freezes the complete execution input and selection manifest', async (t) => {
  const { taskDir, run, root, artifacts, manifest } = await fixture(t);
  await mkdir(path.join(taskDir, 'artifacts/prior-attempt'));
  await writeFile(path.join(taskDir, 'artifacts/prior-attempt/summary.json'), '{}');
  artifacts.push({ path: 'artifacts/prior-attempt/summary.json', purpose: 'other' });
  const inventory = await buildPackageEvidenceManifest(taskDir, artifacts, manifest);
  for (const file of await readdir(root))
    assert(inventory.some((entry) => entry.path === `artifacts/recipe-run/${file}`));
  assert(inventory.every((entry) => entry.sha256));
  assert(!inventory.some((entry) => entry.path.startsWith('artifacts/prior-attempt/')));
  await retainRunFixture(run);
  assert.deepEqual(await readFrozenPublicationManifest(run, inventory), manifest);
  await verifyFrozenPublicationEvidence(run, inventory, ['artifacts/recipe-run/proof.png']);
  const sources = await readFrozenRecordedEvidenceSources(run, inventory, [
    'artifacts/recipe-run/proof.png',
  ]);
  assert.equal(sources.length, 1);
  assert.equal(sources[0]!.artifactPrefix, 'artifacts/recipe-run/');
});

test('pre-cutover reruns retain both declared captures while the gate reads only the selected execution', async (t) => {
  const { taskDir, root, run, artifacts } = await fixture(t);
  const selected = path.join(taskDir, 'artifacts/recipe-runs/old');
  await mkdir(path.dirname(selected), { recursive: true });
  await rename(root, selected);
  for (const artifact of artifacts)
    artifact.path = artifact.path.replace('recipe-run/', 'recipe-runs/old/');
  const prior = path.join(taskDir, 'artifacts/recipe-runs/prior');
  await cp(selected, prior, { recursive: true });
  for (const artifact of [...artifacts])
    artifacts.push({
      ...artifact,
      path: artifact.path.replace('recipe-runs/old/', 'recipe-runs/prior/'),
    });
  const manifest = {
    version: 1,
    standalone: [
      { label: 'Earlier capture', file: 'recipe-runs/prior/proof.png' },
      { label: 'Retained old capture', file: 'recipe-runs/old/proof.png' },
    ],
  };
  await writeFile(path.join(taskDir, 'artifacts/evidence-manifest.json'), JSON.stringify(manifest));
  await writeFile(
    path.join(taskDir, 'artifacts/latest-valid-recipe-run.json'),
    JSON.stringify({ version: 1, relativeArtifactRoot: 'recipe-runs/old' }),
  );
  assert.equal(run.recordedEvidenceContractVersion, undefined);
  await retainRunFixture(run);
  const effective = await readEvidenceManifest(run);
  assert.deepEqual(effective, manifest);
  const inventory = await buildPackageEvidenceManifest(taskDir, artifacts, effective, 0);
  assert(inventory.some((entry) => entry.path === 'artifacts/recipe-runs/prior/proof.png'));
  assert(inventory.some((entry) => entry.path === 'artifacts/recipe-runs/old/proof.png'));
  const prepared = makeReadyGatePackage({
    id: 'old-selected',
    evidenceManifest: inventory,
    selectedEvidenceKeys: ['artifacts/recipe-runs/old/proof.png'],
  });
  prepared.packageHash = computeReadyGatePackageHash(prepared);
  await retainRunFixture(run);
  assert.equal(
    (await readGateRecordedEvidenceSources(run, prepared))[0]?.artifactPrefix,
    'artifacts/recipe-runs/old/',
  );
  run.recordedEvidenceContractVersion = 1;
  await retainRunFixture(run);
  await assert.rejects(readEvidenceManifest(run), /Update the recipe runtime/);
});

test('an attempt without publication media freezes its closure without selecting prior failed packages', async (t) => {
  const { taskDir, root, run, artifacts } = await fixture(t);
  await rm(path.join(taskDir, 'artifacts/evidence-manifest.json'));
  const selected = path.join(taskDir, 'artifacts/recipe-runs/current');
  await mkdir(path.dirname(selected), { recursive: true });
  await rename(root, selected);
  const manifest = { version: 1, standalone: [] };
  await writeFile(path.join(selected, 'evidence-manifest.json'), JSON.stringify(manifest));
  await writeFile(
    path.join(taskDir, 'artifacts/latest-valid-recipe-run.json'),
    JSON.stringify({
      version: 1,
      relativeArtifactRoot: 'recipe-runs/current',
    }),
  );
  for (const artifact of artifacts)
    artifact.path = artifact.path.replace('recipe-run/', 'recipe-runs/current/');
  await mkdir(path.join(taskDir, 'artifacts/failed'));
  await writeFile(path.join(taskDir, 'artifacts/failed/summary.json'), '{}');
  artifacts.push({ path: 'artifacts/failed/summary.json', purpose: 'summary' });
  await retainRunFixture(run);
  const effective = await readEvidenceManifest(run);
  const inventory = await buildPackageEvidenceManifest(taskDir, artifacts, effective);
  assert(inventory.some((entry) => entry.path === 'artifacts/recipe-runs/current/summary.json'));
  assert(
    inventory.some(
      (entry) => entry.path === 'artifacts/recipe-runs/current/evidence-manifest.json',
    ),
  );
  assert(inventory.some((entry) => entry.path === 'artifacts/latest-valid-recipe-run.json'));
  assert(!inventory.some((entry) => entry.path.startsWith('artifacts/failed/')));
  assert.deepEqual(allSelectedEvidenceKeysForPublication(inventory), []);
  await retainRunFixture(run);
  assert.deepEqual(
    await readFrozenPublicationManifest(run, inventory),
    JSON.parse(JSON.stringify(effective)),
  );
  await verifyFrozenPublicationEvidence(run, inventory, []);
  await overwriteRetainedFixture(
    run,
    path.relative(taskDir, path.join(selected, 'trace.json')),
    '[]',
  );
  await assert.rejects(
    verifyFrozenPublicationEvidence(run, inventory, []),
    /missing.*changed.*trace.json/,
  );
});

test('the gate reads only the frozen selected attempt and rejects changed pointer bytes', async (t) => {
  const { taskDir, root, run, artifacts } = await fixture(t);
  run.recordedEvidenceContractVersion = 1;
  const selected = path.join(taskDir, 'artifacts/recipe-runs/current');
  await mkdir(path.dirname(selected), { recursive: true });
  await rename(root, selected);
  await writeFile(
    path.join(selected, 'evidence-manifest.json'),
    JSON.stringify({ version: 1, standalone: [] }),
  );
  const pointerPath = path.join(taskDir, 'artifacts/latest-valid-recipe-run.json');
  await writeFile(
    pointerPath,
    JSON.stringify({ version: 1, relativeArtifactRoot: 'recipe-runs/current' }),
  );
  for (const artifact of artifacts)
    artifact.path = artifact.path.replace('recipe-run/', 'recipe-runs/current/');
  await retainRunFixture(run);
  const effective = await readEvidenceManifest(run);
  const inventory = await buildPackageEvidenceManifest(taskDir, artifacts, effective);
  const unrelated = path.join(taskDir, 'artifacts/summary.json');
  await writeFile(unrelated, '{}');
  inventory.push({
    path: 'artifacts/summary.json',
    purpose: 'summary',
    sha256: digest(await readFile(unrelated)),
  });
  const prepared = makeReadyGatePackage({
    id: 'selected',
    evidenceManifest: inventory,
    selectedEvidenceKeys: [],
  });
  prepared.packageHash = computeReadyGatePackageHash(prepared);
  run.recordedEvidenceContractVersion = 1;
  await retainRunFixture(run);
  const sources = await readGateRecordedEvidenceSources(run, prepared);
  assert.equal(sources.length, 1);
  assert.equal(sources[0]?.artifactPrefix, 'artifacts/recipe-runs/current/');
  await overwriteRetainedFixture(
    run,
    path.relative(taskDir, pointerPath),
    JSON.stringify({ version: 1, relativeArtifactRoot: 'recipe-runs/another' }),
  );
  await assert.rejects(readGateRecordedEvidenceSources(run, prepared), /hash mismatch/);
});

test('a versioned gate cannot fall back to legacy roots and unsupported run contracts refuse', async (t) => {
  const { run, taskDir, artifacts, manifest } = await fixture(t);
  const prepared = makeReadyGatePackage({
    id: 'legacy',
    evidenceManifest: await buildPackageEvidenceManifest(taskDir, artifacts, manifest),
    selectedEvidenceKeys: [],
  });
  prepared.packageHash = computeReadyGatePackageHash(prepared);
  await retainRunFixture(run);
  assert.equal((await readGateRecordedEvidenceSources(run, prepared)).length, 1);
  assert.equal(run.recordedEvidenceContractVersion, undefined);
  run.recordedEvidenceContractVersion = 1;
  await assert.rejects(readGateRecordedEvidenceSources(run, prepared), (error: unknown) => {
    assert.equal((error as { code: string }).code, 'evidence-selection-missing');
    return true;
  });
  run.recordedEvidenceContractVersion = 2;
  await assert.rejects(readGateRecordedEvidenceSources(run, prepared), (error: unknown) => {
    assert.equal((error as { code: string }).code, 'evidence-contract-unsupported');
    return true;
  });
});

test('replacing trace bytes is refused even when the selected media remains unchanged', async (t) => {
  const { taskDir, root, run, artifacts, manifest } = await fixture(t);
  const inventory = await buildPackageEvidenceManifest(taskDir, artifacts, manifest);
  await writeFile(path.join(root, 'trace.json'), '[]');
  await retainRunFixture(run);
  await assert.rejects(
    verifyFrozenPublicationEvidence(run, inventory, ['artifacts/recipe-run/proof.png']),
    /missing.*changed.*trace.json/,
  );
});

test('selection manifest substitution and files added after approval cannot replace frozen facts', async (t) => {
  const { taskDir, root, run, artifacts, manifest } = await fixture(t);
  const inventory = await buildPackageEvidenceManifest(taskDir, artifacts, manifest);
  const manifestPath = path.join(taskDir, 'artifacts/evidence-manifest.json');
  const originalManifest = await readFile(manifestPath);
  await retainRunFixture(run);
  await overwriteRetainedFixture(
    run,
    path.relative(taskDir, manifestPath),
    JSON.stringify({ version: 1, standalone: [{ label: 'New', file: 'recipe-run/new.png' }] }),
  );
  await assert.rejects(readFrozenPublicationManifest(run, inventory), /hash mismatch/);
  await overwriteRetainedFixture(run, path.relative(taskDir, manifestPath), originalManifest);
  await writeFile(path.join(root, 'new.png'), 'new media');
  await indexFixtureArtifact(root, 'new.png');
  await overwriteRetainedFixture(
    run,
    path.relative(taskDir, path.join(root, 'artifact-manifest.json')),
    await readFile(path.join(root, 'artifact-manifest.json')),
  );
  await assert.rejects(
    verifyFrozenPublicationEvidence(run, inventory, ['artifacts/recipe-run/proof.png']),
    /missing.*changed.*artifact-manifest.json/,
  );
});

test('legacy standalone media remains untimed without invented recipe dependencies', async (t) => {
  const taskDir = await mkdtemp(path.join(os.tmpdir(), 'legacy-publication-'));
  t.after(() => rm(taskDir, { recursive: true, force: true }));
  await mkdir(path.join(taskDir, 'artifacts'));
  await writeFile(path.join(taskDir, 'artifacts/proof.png'), 'old captured image');
  const run = makeRun({ id: randomUUID(), taskFile: path.join(taskDir, 'TASK.md') });
  const inventory = await buildPackageEvidenceManifest(
    taskDir,
    [{ path: 'artifacts/proof.png', purpose: 'screenshot' }],
    null,
  );
  assert.equal(inventory.length, 1);
  await retainRunFixture(run);
  assert.equal(await readFrozenPublicationManifest(run, inventory), null);
  await verifyFrozenPublicationEvidence(run, inventory, ['artifacts/proof.png']);
});

test('a selection manifest changed between selection and freezing is refused', async (t) => {
  const { taskDir, artifacts, manifest } = await fixture(t);
  await writeFile(
    path.join(taskDir, 'artifacts/evidence-manifest.json'),
    JSON.stringify({
      ...manifest,
      standalone: [{ ...manifest.standalone[0], label: 'Changed selection' }],
    }),
  );
  await assert.rejects(
    buildPackageEvidenceManifest(taskDir, artifacts, manifest),
    /selection changed while preparing/,
  );
});

test('omitted media is frozen for validation without becoming selectable public evidence', async (t) => {
  const { taskDir, root, artifacts, manifest } = await fixture(t);
  await writeFile(path.join(root, 'private.png'), 'orientation still');
  await indexFixtureArtifact(root, 'private.png');
  artifacts.push({ path: 'artifacts/recipe-run/private.png', purpose: 'screenshot' });
  const inventory = await buildPackageEvidenceManifest(taskDir, artifacts, manifest);
  assert.equal(
    inventory.find((entry) => entry.path.endsWith('/private.png'))?.purpose,
    'evidence-dependency',
  );
  assert.deepEqual(allSelectedEvidenceKeysForPublication(inventory), [
    'artifacts/recipe-run/proof.png',
  ]);
  assert.throws(
    () =>
      assertPublicationEvidenceSelection({
        selectedEvidenceKeys: ['artifacts/recipe-run/private.png'],
        evidenceManifest: inventory,
        trustedEvidenceManifest: undefined,
      }),
    /none is selected/,
  );
});

test('an omitted paired image stays retained but never enters expanded publication selection', async (t) => {
  const { taskDir, root, artifacts } = await fixture(t);
  await writeFile(path.join(root, 'private.png'), 'before still omitted by author');
  await indexFixtureArtifact(root, 'private.png');
  artifacts.push({ path: 'artifacts/recipe-run/private.png', purpose: 'screenshot' });
  const manifest = {
    version: 1,
    before_after_pairs: [
      { label: 'Change', before: 'recipe-run/private.png', after: 'recipe-run/proof.png' },
    ],
    omit: ['recipe-run/private.png'],
  };
  await writeFile(path.join(taskDir, 'artifacts/evidence-manifest.json'), JSON.stringify(manifest));
  const inventory = await buildPackageEvidenceManifest(taskDir, artifacts, manifest);
  assert.deepEqual(
    expandPublicationEvidenceSelection({
      selectedEvidenceKeys: ['artifacts/recipe-run/proof.png'],
      evidenceManifest: inventory,
      trustedEvidenceManifest: manifest,
    }),
    ['artifacts/recipe-run/proof.png'],
  );
});

test('a headless task with an unrelated summary prepares an empty publication inventory', async (t) => {
  const { taskDir } = await fixture(t);
  await writeFile(path.join(taskDir, 'artifacts/summary.json'), '{}');
  assert.deepEqual(
    await buildPackageEvidenceManifest(
      taskDir,
      [{ path: 'artifacts/summary.json', purpose: 'summary' }],
      null,
    ),
    [],
  );
});

test('task-root preparation remains valid after gateway package files are written', async (t) => {
  const { taskDir, root, run } = await fixture(t);
  const artifactsDir = path.join(taskDir, 'artifacts');
  for (const file of await readdir(root))
    await rename(path.join(root, file), path.join(artifactsDir, file));
  await rm(root, { recursive: true });
  const manifest = { version: 1, standalone: [{ label: 'Root capture', file: 'proof.png' }] };
  await writeFile(path.join(artifactsDir, 'evidence-manifest.json'), JSON.stringify(manifest));
  await writeFile(path.join(artifactsDir, 'diff.txt'), 'gateway source diff');
  const artifacts = (await readdir(artifactsDir)).map((file) => ({
    path: `artifacts/${file}`,
    purpose: 'other',
  }));
  const inventory = await buildPackageEvidenceManifest(taskDir, artifacts, manifest);
  for (const file of ['pr-package.json', 'pr-package.md'])
    await writeFile(path.join(artifactsDir, file), 'prepared package');
  await retainRunFixture(run);
  await verifyFrozenPublicationEvidence(run, inventory, ['artifacts/proof.png']);
  assert(!inventory.some((entry) => entry.path.endsWith('/diff.txt')));
});

for (const location of ['promoted', 'inherited'] as const) {
  test(
    location === 'promoted'
      ? 'promoted selection freezes normalized media paths and its original source'
      : 'an inherited manifest cannot replace a missing selected attempt manifest',
    async (t) => {
      const { taskDir, root, run, artifacts } = await fixture(t);
      run.recordedEvidenceContractVersion = 1;
      const promotedRoot = path.join(taskDir, 'artifacts/recipe-runs/retained');
      await mkdir(path.dirname(promotedRoot), { recursive: true });
      await rename(root, promotedRoot);
      for (const artifact of artifacts)
        artifact.path = artifact.path.replace('recipe-run/', 'recipe-runs/retained/');
      await rm(path.join(taskDir, 'artifacts/evidence-manifest.json'));
      await writeFile(
        path.join(taskDir, 'artifacts/latest-valid-recipe-run.json'),
        JSON.stringify({
          version: 1,
          runId: 'retained',
          relativeArtifactRoot: 'recipe-runs/retained',
        }),
      );
      const sourceDir =
        location === 'promoted' ? promotedRoot : path.join(taskDir, 'inputs/inherited');
      await mkdir(sourceDir, { recursive: true });
      const sourcePath = path.join(sourceDir, 'evidence-manifest.json');
      await writeFile(
        sourcePath,
        JSON.stringify({
          version: 1,
          standalone: [{ label: 'Promoted proof', file: 'proof.png' }],
        }),
      );
      if (location === 'inherited') {
        await retainRunFixture(run);
        await assert.rejects(readEvidenceManifest(run), /selected recipe attempt has no/);
        return;
      }
      await retainRunFixture(run);
      const effective = await readEvidenceManifest(run);
      const inventory = await buildPackageEvidenceManifest(taskDir, artifacts, effective);
      await retainRunFixture(run);
      assert.deepEqual(
        await readFrozenPublicationManifest(run, inventory),
        JSON.parse(JSON.stringify(effective)),
      );
      assert.deepEqual(
        expandPublicationEvidenceSelection({
          selectedEvidenceKeys: ['artifacts/recipe-runs/retained/proof.png'],
          evidenceManifest: inventory,
          trustedEvidenceManifest: await readFrozenPublicationManifest(run, inventory),
        }),
        ['artifacts/recipe-runs/retained/proof.png'],
      );
      await verifyFrozenPublicationEvidence(run, inventory, [
        'artifacts/recipe-runs/retained/proof.png',
      ]);
      await overwriteRetainedFixture(
        run,
        path.relative(taskDir, sourcePath),
        JSON.stringify({ version: 1, standalone: [] }),
      );
      await assert.rejects(readFrozenPublicationManifest(run, inventory), /hash mismatch/);
    },
  );
}

test('a valid failed comparison dependency remains inside the head closure without becoming selected claim authority', async (t) => {
  const { taskDir, run } = await fixture(t);
  const { createRecipeRunner, createStandardCoreAdapters, readRecordedEvidencePackage } =
    await import('@farmslot/recipe-runner');
  const { RECIPE_ACTION_MANIFEST_SCHEMA_URL } = await import('@farmslot/protocol');
  const runner = createRecipeRunner({
    actionManifest: {
      $schema: RECIPE_ACTION_MANIFEST_SCHEMA_URL,
      actions: {
        command: {
          description: 'Read the observation.',
          schema: {
            type: 'object',
            properties: { cmd: { type: 'string' } },
            additionalProperties: false,
          },
          examples: [
            {
              action: 'command',
              cmd: 'printf observed',
              intent: 'Read the observed fixture value.',
              next: 'verify',
            },
          ],
        },
        assert_output: {
          description: 'Check the observation.',
          schema: {
            type: 'object',
            properties: { source: { type: 'string' }, contains: { type: 'string' } },
            additionalProperties: false,
          },
          examples: [
            {
              action: 'assert_output',
              source: 'read',
              contains: 'observed',
              intent: 'Verify the observed fixture value.',
              next: 'done',
            },
          ],
        },
        end: { description: 'Finish.', examples: [{ action: 'end', status: 'pass' }] },
      },
    },
    adapters: createStandardCoreAdapters({ actions: ['command', 'assert_output'] }),
    hud: false,
    defaultSource: { kind: 'operator', trust: 'trusted' },
  });
  const recipe = (value: string) => ({
    $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
    title: 'Observe a value',
    description: 'Retain the original assertion.',
    proofTargets: [{ id: 'AC-1', claim: 'The value is observed.', proofMode: 'state' }],
    workflow: {
      entry: 'read',
      nodes: {
        read: {
          action: 'command',
          cmd: `printf ${value}`,
          intent: 'Read the observed fixture value.',
          next: 'verify',
        },
        verify: {
          action: 'assert_output',
          source: 'read',
          contains: 'observed',
          proves: ['AC-1'],
          intent: 'Verify the observed fixture value.',
          next: 'done',
        },
        done: { action: 'end', status: 'pass' },
      },
    },
  });
  const baseline = path.join(taskDir, 'artifacts/baseline');
  const failed = await runner.run({
    projectRoot: taskDir,
    artifactsDir: baseline,
    recipeDocument: recipe('defect'),
  });
  assert.equal(failed.status, 'fail');
  const selected = path.join(taskDir, 'artifacts/selected');
  const head = await runner.run({
    projectRoot: taskDir,
    artifactsDir: selected,
    recipeDocument: recipe('observed'),
    comparisonDependencies: [baseline],
  });
  assert.equal(head.status, 'pass');
  const loaded = await readRecordedEvidencePackage(selected);
  const inventory: ArtifactRef[] = (loaded.input.artifactPaths ?? []).map((file) => ({
    path: `artifacts/selected/${file}`,
    purpose: 'evidence',
    sha256: loaded.input.artifactDigests[file],
  }));
  await retainRunFixture(run);
  const sources = await readFrozenRecordedEvidenceSources(run, inventory);
  assert.equal(sources.length, 1);
  assert.equal(sources[0]?.input.claims?.recipeRunId, head.claims.recipeRunId);
  assert.equal(sources[0]?.input.claims?.criteria[0]?.verdict, 'proven');
  assert.equal(
    sources[0]?.input.comparisonDependencies?.[0]?.input.claims?.recipeRunId,
    failed.claims.recipeRunId,
  );
  assert.equal(
    sources[0]?.input.comparisonDependencies?.[0]?.input.claims?.criteria[0]?.verdict,
    'failed',
  );
});
