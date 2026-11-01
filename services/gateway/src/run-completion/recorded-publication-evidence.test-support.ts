import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';

import type { ArtifactRef, RecipeArtifactManifestEntry } from '@farmslot/protocol';

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export async function indexFixtureArtifact(
  root: string,
  filename: string,
  type: RecipeArtifactManifestEntry['type'] = 'screenshot',
) {
  const manifestPath = path.join(root, 'artifact-manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.artifacts.push({ path: filename, type, label: 'Captured artifact' });
  await writeFile(manifestPath, JSON.stringify(manifest));
}

export async function baselineFixture(
  t: TestContext,
  baselineLog?: string,
  provenanceBranch?: string,
  baselineRoot = 'recipe-baseline-run',
) {
  const { createRecipeRunner, createStandardCoreAdapters, readRecordedEvidencePackage } =
    await import('@farmslot/recipe-runner');
  const { buildRunRecord } = await import('../runs/store.js');
  const taskDir = await mkdtemp(path.join(os.tmpdir(), 'baseline-publication-'));
  t.after(() => rm(taskDir, { recursive: true, force: true }));
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
  const provenance = {
    schemaVersion: 1,
    git_ref: baseSha,
    dirty: false,
    branch: provenanceBranch ?? branch,
  };
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

export async function sameHeadFixture(
  t: TestContext,
  extraLog?: string,
  headSha = 'c'.repeat(40),
  baselineRoot?: string,
) {
  const f = await baselineFixture(t, extraLog, undefined, baselineRoot);
  const { readRecordedEvidencePackage } = await import('@farmslot/recipe-runner');
  for (const root of [f.baselineRoot, f.headRoot]) {
    const directory = path.join(f.taskDir, 'artifacts', root);
    await writeFile(
      path.join(directory, 'product-provenance.json'),
      JSON.stringify({ ...f.provenance, git_ref: headSha }),
    );
    const manifestPath = path.join(directory, 'artifact-manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (
      !manifest.artifacts.some(
        (entry: { path: string }) => entry.path === 'product-provenance.json',
      )
    )
      manifest.artifacts.push({
        path: 'product-provenance.json',
        type: 'json',
        category: 'system',
      });
    await writeFile(manifestPath, JSON.stringify(manifest));
    const { input } = await readRecordedEvidencePackage(directory);
    for (const file of input.artifactPaths ?? []) {
      const entry = f.inventory.find((artifact) => artifact.path === `artifacts/${root}/${file}`);
      if (entry) entry.sha256 = input.artifactDigests[file];
      else
        f.inventory.push({
          path: `artifacts/${root}/${file}`,
          purpose: 'other',
          sha256: input.artifactDigests[file],
        });
    }
  }
  return { ...f, headSha };
}
