import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { assembleLearningPackage } from '../src/learning-package/assemble.js';
import type { HandoffContext, LearningPackageInput } from '../src/learning-package/types.js';
import { writeLearningPackage } from '../src/learning-package/write.js';
import type { Manifest } from '../src/spec/types.js';

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

function initDestinationRepo(): string {
  // The repo sits inside its own private parent so "nothing appeared beside the
  // destination" can be asserted without interference from other tmpdir users.
  const dir = path.join(mkdtempSync(path.join(os.tmpdir(), 'handoff-trav-dest-')), 'repo');
  mkdirSync(dir);
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@example.invalid']);
  git(dir, ['config', 'user.name', 'Handoff Test']);
  writeFileSync(path.join(dir, 'README.md'), '# learnings\n');
  git(dir, ['add', 'README.md']);
  git(dir, ['commit', '-q', '-m', 'chore: init']);
  return dir;
}

function scenario(): { ctx: HandoffContext; input: LearningPackageInput } {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'handoff-trav-ws-'));
  const artifactsDir = path.join(workspace, 'artifacts');
  mkdirSync(artifactsDir, { recursive: true });
  writeFileSync(path.join(workspace, 'TASK.md'), '# Task\n');
  writeFileSync(path.join(artifactsDir, 'report.md'), '# Report\n\nDone.\n');
  writeFileSync(path.join(artifactsDir, 'learnings.md'), '# Learnings\n\nInsight.\n');
  return {
    ctx: { stagingRoot: mkdtempSync(path.join(os.tmpdir(), 'handoff-trav-stage-')), workspace },
    input: {
      surface: 'fleet',
      runRecord: {
        packageId: '20260713T120000Z-fleet-dev-proj-123-a1b2c3d4',
        project: 'demo-farm',
        domain: 'payments',
        engineer: 'eng-1',
        run: { startedAt: '2026-07-13T11:00:00Z', flow: 'dev', outcome: 'success' },
        task: { title: 'Do the thing', sourceKind: 'text', ticket: 'PROJ-123' },
      },
      templateProvenance: [],
      taskDoc: { taskMd: path.join(workspace, 'TASK.md') },
      artifacts: { artifactsDir },
    },
  };
}

/** Assemble a valid package, then plant a traversal value into its manifest. */
function packageWithManifestField(mutate: (manifest: Manifest) => void): string {
  const { ctx, input } = scenario();
  const result = assembleLearningPackage(input, ctx);
  assert.equal(result.status, 'ok');
  if (result.status !== 'ok') throw new Error('unreachable');
  const manifestPath = path.join(result.packageDir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
  mutate(manifest);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return result.packageDir;
}

const CONSENT = {
  humanApproval: true,
  approvedBy: 'eng-1',
  grantedAt: '2026-07-13T12:00:00Z',
} as const;

test('a path-shaped manifest field refuses the write - nothing lands outside the destination', () => {
  const cases: { label: string; mutate: (m: Manifest) => void }[] = [
    { label: 'engineer', mutate: (m) => (m.engineer = '../../escape') },
    { label: 'surface', mutate: (m) => (m.surface = '../outside') },
    { label: 'project', mutate: (m) => (m.project = 'a/b') },
    { label: 'domain', mutate: (m) => (m.domain = '..') },
    { label: 'flow', mutate: (m) => (m.run.flow = '.hidden') },
    { label: 'taskKey', mutate: (m) => (m.taskKey = '../family') },
    { label: 'ticket', mutate: (m) => (m.task.ticket = '../../tick') },
  ];
  for (const { label, mutate } of cases) {
    const packageDir = packageWithManifestField(mutate);
    const destination = initDestinationRepo();
    const parent = path.dirname(destination);

    assert.throws(
      () => writeLearningPackage({ packageDir, destination, consent: CONSENT }),
      /unsafe path segment/,
      `${label} traversal not refused`,
    );
    // Dry-run computes the same paths and must refuse identically.
    assert.throws(
      () => writeLearningPackage({ packageDir, destination, dryRun: true }),
      /unsafe path segment/,
      `${label} traversal not refused in dryRun`,
    );

    // No IO happened: destination untouched, nothing appeared beside it in its
    // private parent dir.
    assert.equal(existsSync(path.join(destination, 'packages')), false, label);
    assert.equal(existsSync(path.join(destination, 'indexes')), false, label);
    assert.equal(git(destination, ['status', '--porcelain']), '', label);
    const siblings = execFileSync('ls', [parent], { encoding: 'utf8' }).trim().split('\n');
    assert.deepEqual(siblings, ['repo'], label);
  }
});

test('a path-shaped packageId refuses assembly before any staging IO', () => {
  const { ctx, input } = scenario();
  input.runRecord.packageId = '../../outside-staging';
  assert.throws(() => assembleLearningPackage(input, ctx), /unsafe path segment/);
  assert.equal(existsSync(path.join(path.dirname(ctx.stagingRoot), 'outside-staging')), false);
});

test('a path-shaped harness name refuses assembly', () => {
  const { ctx, input } = scenario();
  const harnessDir = path.join(ctx.workspace as string, 'harness-out');
  mkdirSync(harnessDir, { recursive: true });
  writeFileSync(path.join(harnessDir, 'summary.json'), '{}');
  input.artifacts.harnessOutputDirs = [{ name: '../escape', dir: harnessDir }];
  assert.throws(() => assembleLearningPackage(input, ctx), /unsafe path segment/);
});

test('a traversal media packagePath cannot copy outside the package dir', () => {
  const { ctx, input } = scenario();
  const shot = path.join(ctx.workspace as string, 'shot.png');
  writeFileSync(shot, 'pretend-png-bytes');
  input.media = [
    {
      absolutePath: shot,
      packagePath: '../../smuggled.png',
      kind: 'screenshot',
      evidenceManifestSelected: true,
      visualPass: {
        file: '../../smuggled.png',
        passedAt: '2026-07-13T12:00:00Z',
        attestedBy: 'agent-model',
        finding: 'clear',
      },
    },
  ];
  assert.throws(() => assembleLearningPackage(input, ctx), /escapes its root/);
  assert.equal(existsSync(path.join(path.dirname(ctx.stagingRoot), 'smuggled.png')), false);
});
