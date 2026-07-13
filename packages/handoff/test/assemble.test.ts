import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { assembleLearningPackage } from '../src/learning-package/assemble.js';
import type { HandoffContext, LearningPackageInput } from '../src/learning-package/types.js';
import { REQUIRED_FILES } from '../src/spec/version.js';
import { validateLearningPackage } from '../src/validate/validate-package.js';

function tempDir(prefix: string): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

interface Scenario {
  workspace: string;
  ctx: HandoffContext;
  input: LearningPackageInput;
}

function scenario(overrides: { learnings?: string; report?: string } = {}): Scenario {
  const workspace = tempDir('handoff-ws-');
  const artifactsDir = path.join(workspace, 'artifacts');
  mkdirSync(artifactsDir, { recursive: true });
  writeFileSync(path.join(workspace, 'TASK.md'), '# Task\n\nDo the thing.\n');
  writeFileSync(path.join(artifactsDir, 'report.md'), overrides.report ?? '# Report\n\nDone.\n');
  writeFileSync(
    path.join(artifactsDir, 'learnings.md'),
    overrides.learnings ?? '# Learnings\n\nParameterize before multiplying.\n',
  );

  const ctx: HandoffContext = { stagingRoot: tempDir('handoff-stage-'), workspace };
  const input: LearningPackageInput = {
    surface: 'fleet',
    runRecord: {
      packageId: '20260703T154211Z-fleet-dev-proj-123-a1b2c3d4',
      project: 'demo-farm',
      domain: '',
      engineer: 'eng-1',
      run: { startedAt: '2026-07-03T15:42:11Z', flow: 'dev', outcome: 'success' },
      task: { title: 'Do the thing', sourceKind: 'jira', ticket: 'PROJ-123' },
      source: { title: 'Do the thing', description: 'thing', ticket: 'PROJ-123' },
      extensions: { runProfile: 'autonomous' },
    },
    templateProvenance: [
      {
        kind: 'task-template',
        resolvedPath: '$FARMSLOT_HOME/handoff/templates/dev.md',
        tier: 'personal',
        shadows: [{ path: 'default/TASK.md', tier: 'default' }],
      },
    ],
    taskDoc: { taskMd: path.join(workspace, 'TASK.md') },
    artifacts: { artifactsDir },
  };
  return { workspace, ctx, input };
}

test('assemble produces all eight MUST files from minimal fleet inputs and validates', () => {
  const { ctx, input } = scenario();
  const result = assembleLearningPackage(input, ctx);
  assert.equal(result.status, 'ok');
  if (result.status !== 'ok') return;

  for (const required of REQUIRED_FILES) {
    assert.ok(existsSync(path.join(result.packageDir, required)), `missing ${required}`);
  }
  assert.equal(result.manifest.scrubbing.status, 'pass');
  assert.deepEqual(result.manifest.extensions, { runProfile: 'autonomous' });

  const validation = validateLearningPackage(result.packageDir);
  assert.deepEqual(validation.errors, []);
  assert.equal(validation.valid, true);
});

test('assemble folds harness json and cleared media into artifacts/index and validates', () => {
  const { ctx, input, workspace } = scenario();
  const harnessDir = path.join(workspace, 'harness-out');
  mkdirSync(harnessDir, { recursive: true });
  writeFileSync(path.join(harnessDir, 'summary.json'), JSON.stringify({ status: 'passed' }));
  writeFileSync(path.join(harnessDir, 'trace.json'), JSON.stringify({ events: [] }));
  const shot = path.join(workspace, 'shot.png');
  writeFileSync(shot, 'pretend-png-bytes');

  input.artifacts.harnessOutputDirs = [{ name: 'example-runner', dir: harnessDir }];
  input.media = [
    {
      absolutePath: shot,
      packagePath: 'harness/example-runner/shot.png',
      kind: 'screenshot',
      evidenceManifestSelected: true,
      visualPass: {
        file: 'harness/example-runner/shot.png',
        passedAt: '2026-07-03T15:45:00Z',
        attestedBy: 'agent-model',
        finding: 'clear',
      },
    },
  ];

  const result = assembleLearningPackage(input, ctx);
  assert.equal(result.status, 'ok');
  if (result.status !== 'ok') return;

  const index = JSON.parse(
    readFileSync(path.join(result.packageDir, 'artifacts/index.json'), 'utf8'),
  ) as { artifacts: { path: string; kind: string }[] };
  const paths = index.artifacts.map((a) => a.path);
  assert.ok(paths.includes('harness/example-runner/summary.json'));
  assert.ok(paths.includes('harness/example-runner/trace.json'));
  assert.ok(paths.includes('harness/example-runner/shot.png'));

  const validation = validateLearningPackage(result.packageDir);
  assert.deepEqual(validation.errors, []);
});

test('a planted SRP blocks assembly: quarantine only, no packageDir, no raw artifacts', () => {
  const { ctx, input } = scenario({
    learnings:
      '# Learnings\n\nseed was abandon ability able about above absent absorb abstract absurd abuse access accident\n',
  });
  const result = assembleLearningPackage(input, ctx);
  assert.equal(result.status, 'blocked');
  if (result.status !== 'blocked') return;

  // No package dir exists for the run.
  assert.equal(existsSync(path.join(ctx.stagingRoot, input.runRecord.packageId)), false);
  assert.equal('packageDir' in result, false);

  // Quarantine holds ONLY the audit trail - never raw artifacts.
  const entries = readdirSync(result.quarantineDir).sort();
  assert.deepEqual(entries, ['manifest.json', 'scrub-report.json']);
  assert.equal(existsSync(path.join(result.quarantineDir, 'learnings.md')), false);

  const manifest = JSON.parse(
    readFileSync(path.join(result.quarantineDir, 'manifest.json'), 'utf8'),
  ) as { scrubbing: { status: string } };
  assert.equal(manifest.scrubbing.status, 'blocked');
  assert.equal(result.scrubReport.status, 'blocked');
  assert.ok(result.scrubReport.blocked.length >= 1);
});

test('quarantine dir path is local staging, never a repo destination prefix', () => {
  const { ctx, input } = scenario({
    learnings:
      '# Learnings\n\nabandon ability able about above absent absorb abstract absurd abuse access accident\n',
  });
  const result = assembleLearningPackage(input, ctx);
  assert.equal(result.status, 'blocked');
  if (result.status !== 'blocked') return;
  assert.ok(result.quarantineDir.startsWith(ctx.stagingRoot));
  assert.ok(result.quarantineDir.includes(`${path.sep}quarantine${path.sep}`));
  assert.equal(result.quarantineDir.includes('packages/2026'), false);
});

test('farm scrub options apply during assembly: extra deny pattern blocks, floor stays intact', () => {
  const { ctx, input } = scenario({
    learnings: '# Learnings\n\nused FARM-FIXTURE-SECRET-42 during setup\n',
  });
  input.scrub = {
    extraDenyPatterns: [{ kind: 'farm-fixture-tag', pattern: /FARM-FIXTURE-SECRET-[0-9]+/g }],
  };
  const result = assembleLearningPackage(input, ctx);
  assert.equal(result.status, 'blocked');
  if (result.status !== 'blocked') return;
  assert.ok(result.scrubReport.blocked.some((b) => b.kind === 'farm-fixture-tag'));

  // UNION-only: with the same options, a floor secret still blocks.
  const floor = scenario({
    learnings:
      '# Learnings\n\nabandon ability able about above absent absorb abstract absurd abuse access accident\n',
  });
  floor.input.scrub = input.scrub;
  const floorResult = assembleLearningPackage(floor.input, floor.ctx);
  assert.equal(floorResult.status, 'blocked');
  if (floorResult.status !== 'blocked') return;
  assert.ok(floorResult.scrubReport.blocked.some((b) => b.kind === 'srp'));
});
