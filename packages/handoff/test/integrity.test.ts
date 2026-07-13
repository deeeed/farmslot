import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { assembleLearningPackage } from '../src/learning-package/assemble.js';
import type { HandoffContext, LearningPackageInput } from '../src/learning-package/types.js';
import { writeLearningPackage } from '../src/learning-package/write.js';
import { validateLearningPackage } from '../src/validate/validate-package.js';

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

function initDestinationRepo(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'handoff-integ-dest-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@example.invalid']);
  git(dir, ['config', 'user.name', 'Handoff Test']);
  writeFileSync(path.join(dir, 'README.md'), '# learnings\n');
  git(dir, ['add', 'README.md']);
  git(dir, ['commit', '-q', '-m', 'chore: init']);
  return dir;
}

function scenario(learnings?: string): { ctx: HandoffContext; input: LearningPackageInput } {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'handoff-integ-ws-'));
  const artifactsDir = path.join(workspace, 'artifacts');
  mkdirSync(artifactsDir, { recursive: true });
  writeFileSync(path.join(workspace, 'TASK.md'), '# Task\n');
  writeFileSync(path.join(artifactsDir, 'report.md'), '# Report\n\nDone.\n');
  writeFileSync(path.join(artifactsDir, 'learnings.md'), learnings ?? '# Learnings\n\nInsight.\n');
  return {
    ctx: { stagingRoot: mkdtempSync(path.join(os.tmpdir(), 'handoff-integ-stage-')), workspace },
    input: {
      surface: 'fleet',
      runRecord: {
        packageId: '20260713T130000Z-fleet-dev-proj-123-a1b2c3d4',
        project: 'demo-farm',
        domain: '',
        engineer: 'eng-1',
        run: { startedAt: '2026-07-13T12:00:00Z', flow: 'dev', outcome: 'success' },
        task: { title: 'Do the thing', sourceKind: 'text', ticket: 'PROJ-123' },
      },
      templateProvenance: [],
      taskDoc: { taskMd: path.join(workspace, 'TASK.md') },
      artifacts: { artifactsDir },
    },
  };
}

const CONSENT = {
  humanApproval: true,
  approvedBy: 'eng-1',
  grantedAt: '2026-07-13T13:00:00Z',
} as const;

test('a file tampered after assembly fails validation and refuses the write', () => {
  const { ctx, input } = scenario();
  const result = assembleLearningPackage(input, ctx);
  assert.equal(result.status, 'ok');
  if (result.status !== 'ok') return;

  writeFileSync(path.join(result.packageDir, 'report.md'), '# Report\n\nSwapped content.\n');

  const validation = validateLearningPackage(result.packageDir);
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((e) => e.includes('sha256 mismatch')));

  const destination = initDestinationRepo();
  assert.throws(
    () => writeLearningPackage({ packageDir: result.packageDir, destination, consent: CONSENT }),
    /sha256 mismatch/,
  );
  assert.equal(existsSync(path.join(destination, 'packages')), false);
});

test('an uninventoried extra file refuses the write (never scrubbed, never shared)', () => {
  const { ctx, input } = scenario();
  const result = assembleLearningPackage(input, ctx);
  assert.equal(result.status, 'ok');
  if (result.status !== 'ok') return;

  writeFileSync(path.join(result.packageDir, 'smuggled.md'), 'never went through the gate\n');

  // The consumer validator tolerates unknown files (forward-compat)...
  assert.equal(validateLearningPackage(result.packageDir).valid, true);
  // ...but the share gate refuses them.
  const destination = initDestinationRepo();
  assert.throws(
    () => writeLearningPackage({ packageDir: result.packageDir, destination, consent: CONSENT }),
    /not in the manifest inventory/,
  );
  assert.equal(existsSync(path.join(destination, 'packages')), false);
});

test('re-assembly starts from a fresh staging dir: stale files never survive', () => {
  const { ctx, input } = scenario();
  // Plant a stale file where the package will be staged.
  const staleDir = path.join(ctx.stagingRoot, input.runRecord.packageId);
  mkdirSync(staleDir, { recursive: true });
  writeFileSync(path.join(staleDir, 'stale-unscanned.md'), 'left over from a previous attempt\n');

  const result = assembleLearningPackage(input, ctx);
  assert.equal(result.status, 'ok');
  if (result.status !== 'ok') return;
  assert.equal(existsSync(path.join(result.packageDir, 'stale-unscanned.md')), false);
  assert.equal('stale-unscanned.md' in result.manifest.files, false);
});

test('quarantine contains ONLY manifest + scrub-report even when the dir was reused', () => {
  const { ctx, input } = scenario(
    '# Learnings\n\nabandon ability able about above absent absorb abstract absurd abuse access accident\n',
  );
  // Plant stale raw content where the quarantine will land.
  const staleQuarantine = path.join(ctx.stagingRoot, 'quarantine', input.runRecord.packageId);
  mkdirSync(staleQuarantine, { recursive: true });
  writeFileSync(path.join(staleQuarantine, 'raw-artifact.md'), 'raw leftovers\n');

  const result = assembleLearningPackage(input, ctx);
  assert.equal(result.status, 'blocked');
  if (result.status !== 'blocked') return;
  assert.deepEqual(readdirSync(result.quarantineDir).sort(), [
    'manifest.json',
    'scrub-report.json',
  ]);
});

test('duplicate package-relative paths across inputs refuse assembly', () => {
  const { ctx, input } = scenario();
  const shot = path.join(ctx.workspace as string, 'shot.png');
  writeFileSync(shot, 'approved-bytes');
  const smuggle = path.join(ctx.workspace as string, 'smuggle.png');
  writeFileSync(smuggle, 'unapproved-bytes');
  const attestation = {
    file: 'harness/x/shot.png',
    passedAt: '2026-07-13T13:00:00Z',
    attestedBy: 'agent-model',
    finding: 'clear' as const,
  };
  input.media = [
    {
      absolutePath: shot,
      packagePath: 'harness/x/shot.png',
      kind: 'screenshot',
      evidenceManifestSelected: true,
      visualPass: attestation,
    },
    // Second input at the SAME package path - must never replace approved bytes.
    {
      absolutePath: smuggle,
      packagePath: 'harness/x/shot.png',
      kind: 'screenshot',
      evidenceManifestSelected: false,
    },
  ];
  assert.throws(() => assembleLearningPackage(input, ctx), /duplicate package path/);
});
