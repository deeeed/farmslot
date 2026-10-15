import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  type EvidenceManifest,
  RECIPE_ACTION_MANIFEST_SCHEMA_URL,
  type RecipeActionManifestDocument,
} from '@farmslot/protocol';

import { createStandardCoreAdapters } from '../src/adapters/core.js';
import { createRecipeRunner } from '../src/core/runner.js';
import { validateRecordedEvidencePackage } from '../src/evidence/package.js';
import { readRecordedEvidencePackage } from '../src/evidence/read-package.js';

const manifest: RecipeActionManifestDocument = {
  $schema: RECIPE_ACTION_MANIFEST_SCHEMA_URL,
  actions: {
    'ui.screenshot': {
      description: 'Capture the visible state.',
      schema: { type: 'object', properties: {}, additionalProperties: false },
      examples: [
        {
          action: 'ui.screenshot',
          intent: 'Keep a picture of the visible order controls for comparison.',
          next: 'done',
        },
      ],
    },
    command: {
      description: 'Read the fixture.',
      schema: {
        type: 'object',
        properties: { cmd: { type: 'string' } },
        additionalProperties: false,
      },
      examples: [
        {
          action: 'command',
          cmd: 'printf order-controls',
          intent: 'Read the fixture order controls.',
          next: 'done',
        },
      ],
    },
    assert_output: {
      description: 'Verify the fixture.',
      schema: {
        type: 'object',
        properties: { source: { type: 'string' }, contains: { type: 'string' } },
        additionalProperties: false,
      },
      examples: [
        {
          action: 'assert_output',
          source: 'read',
          contains: 'order-controls',
          intent: 'Verify the fixture order controls.',
          next: 'done',
        },
      ],
    },
    end: { description: 'Finish.', examples: [{ action: 'end', status: 'pass' }] },
  },
};

const recipe = (role: 'before' | 'after') => ({
  $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
  title: 'Compare the criterion',
  description: 'Capture explicit comparison evidence without claiming proof.',
  proofTargets: [{ id: 'AC-1', claim: 'The state is visible.', proofMode: 'state' }],
  workflow: {
    entry: 'read',
    nodes: {
      read: {
        action: 'command',
        cmd: 'printf order-controls',
        intent: 'Read the fixture order controls.',
        next: 'verify',
      },
      verify: {
        action: 'assert_output',
        source: 'read',
        contains: 'order-controls',
        proves: ['AC-1'],
        intent: 'Confirm that the order controls are visible.',
        next: 'capture',
      },
      capture: {
        action: 'ui.screenshot',
        ac: 'AC-1',
        role,
        intent: 'Keep the visible criterion.',
        next: 'done',
      },
      done: { action: 'end', status: 'pass' },
    },
  },
});

test('engine observes git source, retains baseline bytes and derives publication covers without changing verdicts', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'comparison-source-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.test');
  await writeFile(path.join(root, 'source.txt'), 'before');
  git('add', 'source.txt');
  git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'before');
  const baseSha = git('rev-parse', 'HEAD');
  const runner = createRecipeRunner({
    actionManifest: manifest,
    hud: false,
    defaultSource: { kind: 'operator', trust: 'trusted' },
    adapters: [
      ...createStandardCoreAdapters({ actions: ['command', 'assert_output'] }),
      {
        action: 'ui.screenshot',
        source: { kind: 'bundled', trust: 'trusted' },
        async execute(_node, context) {
          await writeFile(context.resolveArtifactPath('capture.png'), 'identical media bytes');
          const artifact = {
            path: 'capture.png',
            type: 'screenshot',
            capture: { recipeRunId: 'forged', nodeId: 'forged', traceIndex: 999 },
          };
          context.registerArtifact(artifact);
          return { artifacts: [artifact] };
        },
      },
    ],
  });
  const baselineDir = path.join(root, 'artifacts', 'baseline');
  const baseline = await runner.run({
    recipeDocument: recipe('before'),
    projectRoot: root,
    artifactsDir: baselineDir,
    recordVideo: false,
    recordingReason: 'Fixture has no recorder.',
  });
  const original = await readFile(path.join(baselineDir, 'artifact-manifest.json'));
  await writeFile(path.join(root, 'source.txt'), 'after');
  git('add', 'source.txt');
  git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'after');
  const headSha = git('rev-parse', 'HEAD');
  const headDir = path.join(root, 'artifacts', 'head');
  const result = await runner.run({
    recipeDocument: recipe('after'),
    projectRoot: root,
    artifactsDir: headDir,
    comparisonDependencies: [baselineDir],
    comparisonSnapshot: { baseSha, headSha },
    recordVideo: false,
    recordingReason: 'Fixture has no recorder.',
  });
  const loaded = await readRecordedEvidencePackage(headDir);
  assert.ok(
    loaded.checks.every((check) => check.status === 'pass'),
    JSON.stringify(loaded.checks),
  );
  const validated = validateRecordedEvidencePackage(loaded.input);
  assert.equal(validated.status, 'valid', JSON.stringify(validated.findings));
  assert.equal(result.claims?.criteria[0]?.verdict, baseline.claims?.criteria[0]?.verdict);
  const artifactManifest = JSON.parse(
    await readFile(path.join(headDir, 'artifact-manifest.json'), 'utf8'),
  );
  const capture = artifactManifest.artifacts.find(
    (entry: { path: string }) => entry.path === 'capture.png',
  ).capture;
  assert.equal(capture.sourceCommit, headSha);
  assert.equal(capture.sourceDirty, false);
  assert.equal(capture.recipeRunId, result.claims.recipeRunId);
  assert.equal(capture.traceIndex, 2);
  assert.equal(
    loaded.input.comparisonDependencies?.[0]?.input.claims?.recipeRunId,
    baseline.claims.recipeRunId,
  );
  const publication: EvidenceManifest = JSON.parse(
    await readFile(path.join(headDir, 'evidence-manifest.json'), 'utf8'),
  );
  assert.deepEqual(publication.before_after_pairs?.[0]?.covers, ['AC-1']);
  assert.equal(
    publication.before_after_pairs?.[0]?.before,
    `comparison-dependencies/${baseline.claims.recipeRunId}/capture.png`,
  );
  assert.equal(publication.before_after_pairs?.[0]?.after, 'capture.png');
  assert.notEqual(baseSha, headSha);
  assert.deepEqual(await readFile(path.join(baselineDir, 'artifact-manifest.json')), original);
  await writeFile(
    path.join(headDir, `comparison-dependencies/${baseline.claims.recipeRunId}/capture.png`),
    'changed retained dependency',
  );
  const changed = await readRecordedEvidencePackage(headDir);
  assert.ok(
    changed.checks.some((check) => check.status === 'fail' && check.id.endsWith('identity')),
  );
  assert.equal(validateRecordedEvidencePackage(changed.input).status, 'invalid');
});

test('canonical reader refuses escaping and cyclic comparison declarations using trusted IO too', async () => {
  for (const artifactRoot of ['../elsewhere', 'comparison-dependencies/head']) {
    const loaded = await readRecordedEvidencePackage('unused', {
      listPaths: async () => [
        'summary.json',
        'trace.json',
        'artifact-manifest.json',
        'acceptance-status.json',
      ],
      readJson: async (file) =>
        file === 'artifact-manifest.json'
          ? {
              artifacts: [],
              comparisonDependencies: [
                { artifactRoot, recipeRunId: 'head', closureIdentity: 'sha256:' + '0'.repeat(64) },
              ],
            }
          : file === 'acceptance-status.json'
            ? { recipeRunId: 'head' }
            : {},
      digestFile: async () => 'sha256:' + '0'.repeat(64),
    });
    assert.ok(
      loaded.checks.some((check) => check.id === 'comparison.root' && check.status === 'fail'),
    );
  }
});

test('existing target roles remain action inputs rather than capture annotations', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'capture-role-input-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let observedRole: unknown;
  const runner = createRecipeRunner({
    defaultSource: { kind: 'operator', trust: 'trusted' },
    actionManifest: {
      ...manifest,
      actions: {
        end: manifest.actions.end!,
        'cdp.target': {
          description: 'Select the runtime target.',
          schema: {
            type: 'object',
            properties: { role: { type: 'string' } },
            additionalProperties: false,
          },
          examples: [
            {
              action: 'cdp.target',
              intent: 'Select the extension target for this control.',
              role: 'extension',
              next: 'done',
            },
          ],
        },
      },
    },
    adapters: [
      {
        action: 'cdp.target',
        source: { kind: 'bundled', trust: 'trusted' },
        async execute(node) {
          observedRole = node.role;
          return {};
        },
      },
    ],
  });
  const result = await runner.run({
    projectRoot: root,
    artifactsDir: path.join(root, 'artifacts'),
    recordVideo: false,
    recordingReason: 'Nonvisual parameter control.',
    recipeDocument: {
      $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
      title: 'Target role control',
      description: 'Keep existing action role parameters.',
      workflow: {
        entry: 'target',
        nodes: {
          target: {
            action: 'cdp.target',
            intent: 'Select the extension target for this control.',
            role: 'extension',
            next: 'done',
          },
          done: { action: 'end', status: 'pass' },
        },
      },
    },
  });
  assert.equal(result.status, 'pass', JSON.stringify(result));
  assert.equal(observedRole, 'extension');
});
