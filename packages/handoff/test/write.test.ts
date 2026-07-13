import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { assembleLearningPackage } from '../src/learning-package/assemble.js';
import type {
  AssembleResult,
  HandoffContext,
  LearningPackageInput,
} from '../src/learning-package/types.js';
import { writeLearningPackage } from '../src/learning-package/write.js';
import type { IndexRow } from '../src/spec/types.js';

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

function initDestinationRepo(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'handoff-learnings-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@example.invalid']);
  git(dir, ['config', 'user.name', 'Handoff Test']);
  writeFileSync(path.join(dir, 'README.md'), '# learnings\n');
  git(dir, ['add', 'README.md']);
  git(dir, ['commit', '-q', '-m', 'chore: init']);
  return dir;
}

function assembled(learnings?: string): { result: AssembleResult; ctx: HandoffContext } {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'handoff-write-ws-'));
  const artifactsDir = path.join(workspace, 'artifacts');
  mkdirSync(artifactsDir, { recursive: true });
  writeFileSync(path.join(workspace, 'TASK.md'), '# Task\n');
  writeFileSync(path.join(artifactsDir, 'report.md'), '# Report\n\nDone.\n');
  writeFileSync(path.join(artifactsDir, 'learnings.md'), learnings ?? '# Learnings\n\nInsight.\n');
  const ctx: HandoffContext = {
    stagingRoot: mkdtempSync(path.join(os.tmpdir(), 'handoff-write-stage-')),
    workspace,
  };
  const input: LearningPackageInput = {
    surface: 'fleet',
    runRecord: {
      packageId: '20260703T154211Z-fleet-dev-proj-123-a1b2c3d4',
      project: 'demo-farm',
      domain: 'payments',
      engineer: 'eng-1',
      run: {
        startedAt: '2026-07-03T15:42:11Z',
        finishedAt: '2026-07-03T16:00:00Z',
        flow: 'dev',
        outcome: 'success',
      },
      task: { title: 'Do the thing', sourceKind: 'text', ticket: 'PROJ-123' },
    },
    templateProvenance: [],
    taskDoc: { taskMd: path.join(workspace, 'TASK.md') },
    artifacts: { artifactsDir },
  };
  return { result: assembleLearningPackage(input, ctx), ctx };
}

const CONSENT = {
  humanApproval: true,
  approvedBy: 'eng-1',
  grantedAt: '2026-07-13T10:00:00Z',
} as const;

test('dryRun computes the would-write path and index rows with no destination IO', () => {
  const { result } = assembled();
  assert.equal(result.status, 'ok');
  if (result.status !== 'ok') return;

  const destination = mkdtempSync(path.join(os.tmpdir(), 'handoff-untouched-'));
  const write = writeLearningPackage({
    packageDir: result.packageDir,
    destination,
    dryRun: true,
  });
  assert.equal(write.status, 'dry-run');
  if (write.status !== 'dry-run') return;
  assert.equal(write.pushed, false);
  assert.equal(
    write.wouldWritePath,
    'packages/2026/07/03/fleet/demo-farm/20260703T154211Z-fleet-dev-proj-123-a1b2c3d4',
  );
  const row: IndexRow = write.indexRows[0];
  assert.equal(row.taskKey, 'proj-123');
  assert.equal(row.packageId, result.manifest.packageId);
  assert.equal(row.packageSchemaVersion, 1);
  // No git IO, no writes: the destination stays empty (dryRun never touches it).
  assert.equal(existsSync(path.join(destination, 'packages')), false);
  assert.equal(existsSync(path.join(destination, '.git')), false);
});

test('a real write requires explicit per-call human approval', () => {
  const { result } = assembled();
  assert.equal(result.status, 'ok');
  if (result.status !== 'ok') return;
  const destination = initDestinationRepo();
  assert.throws(
    () => writeLearningPackage({ packageDir: result.packageDir, destination }),
    /human approval/,
  );
});

test('write is append-only: package copy + one row per index file, committed; rewrite refused', () => {
  const { result } = assembled();
  assert.equal(result.status, 'ok');
  if (result.status !== 'ok') return;
  const destination = initDestinationRepo();

  const write = writeLearningPackage({
    packageDir: result.packageDir,
    destination,
    consent: CONSENT,
  });
  assert.equal(write.status, 'written');
  if (write.status !== 'written') return;
  assert.match(write.commitSha, /^[a-f0-9]{40}$/);
  assert.equal(write.pushed, false); // no remote configured in the test repo
  assert.ok(existsSync(path.join(write.destinationPath, 'manifest.json')));

  // One identical row per index dimension, including the by-task family index.
  const indexFiles = [
    'indexes/by-engineer/eng-1.jsonl',
    'indexes/by-project/demo-farm.jsonl',
    'indexes/by-domain/payments.jsonl',
    'indexes/by-flow/dev.jsonl',
    'indexes/by-ticket/proj-123.jsonl',
    'indexes/by-task/proj-123.jsonl',
  ];
  for (const file of indexFiles) {
    const abs = path.join(destination, file);
    assert.ok(existsSync(abs), `missing ${file}`);
    const lines = readFileSync(abs, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1, `${file} should have exactly one row`);
    assert.equal((JSON.parse(lines[0]) as IndexRow).taskKey, 'proj-123');
  }

  // The write is one clean commit; the tree is clean afterwards.
  assert.equal(git(destination, ['status', '--porcelain']), '');

  // Append-only: writing the same package again is refused, nothing is overwritten.
  assert.throws(
    () => writeLearningPackage({ packageDir: result.packageDir, destination, consent: CONSENT }),
    /append-only/,
  );
});

test('index rows append across packages, never overwrite', () => {
  const first = assembled();
  assert.equal(first.result.status, 'ok');
  if (first.result.status !== 'ok') return;
  const destination = initDestinationRepo();
  writeLearningPackage({ packageDir: first.result.packageDir, destination, consent: CONSENT });

  // Second attempt at the SAME task family: distinct run-slug, same taskKey.
  const second = assembled();
  assert.equal(second.result.status, 'ok');
  if (second.result.status !== 'ok') return;
  const manifestPath = path.join(second.result.packageDir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { packageId: string };
  manifest.packageId = '20260703T170000Z-fleet-dev-proj-123-ffffffff';
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  writeLearningPackage({ packageDir: second.result.packageDir, destination, consent: CONSENT });

  const family = readFileSync(path.join(destination, 'indexes/by-task/proj-123.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => (JSON.parse(line) as IndexRow).packageId);
  assert.deepEqual(family, [
    '20260703T154211Z-fleet-dev-proj-123-a1b2c3d4',
    '20260703T170000Z-fleet-dev-proj-123-ffffffff',
  ]);
});

test('a hand-built blocked package dir is refused at the pre-write assertion', () => {
  const { result, ctx } = assembled(
    '# Learnings\n\nabandon ability able about above absent absorb abstract absurd abuse access accident\n',
  );
  assert.equal(result.status, 'blocked');
  if (result.status !== 'blocked') return;

  // Someone wrongly points writeLearningPackage at the quarantine dir: the
  // runtime precondition still refuses (defense in depth behind the type barrier).
  const destination = initDestinationRepo();
  assert.throws(
    () => writeLearningPackage({ packageDir: result.quarantineDir, destination, consent: CONSENT }),
    /scrubbing\.status 'blocked'/,
  );
  assert.equal(existsSync(path.join(destination, 'packages')), false);
  assert.ok(ctx.stagingRoot); // quarantine stayed local to staging
});

test('passing a blocked AssembleResult to writeLearningPackage is a compile-time type error', () => {
  const blocked = { status: 'blocked', quarantineDir: '/tmp/q', scrubReport: {} } as Extract<
    AssembleResult,
    { status: 'blocked' }
  >;
  // The blocked arm has no packageDir - the share barrier is enforced by the type
  // system before any runtime check. (tsc verifies this expected error.)
  // @ts-expect-error - property 'packageDir' does not exist on a blocked result
  const packageDir: string = blocked.packageDir;
  assert.equal(packageDir, undefined);
});

test('a dirty destination tree refuses the write before any IO', () => {
  const { result } = assembled();
  assert.equal(result.status, 'ok');
  if (result.status !== 'ok') return;
  const destination = initDestinationRepo();
  writeFileSync(path.join(destination, 'uncommitted.txt'), 'wip\n');
  assert.throws(
    () => writeLearningPackage({ packageDir: result.packageDir, destination, consent: CONSENT }),
    /uncommitted changes/,
  );
  assert.equal(existsSync(path.join(destination, 'packages')), false);
});

test('a mid-write failure rolls back: no partial package, no partial index rows, clean tree', () => {
  const { result } = assembled();
  assert.equal(result.status, 'ok');
  if (result.status !== 'ok') return;
  const destination = initDestinationRepo();
  // Commit `indexes` as a FILE so the index-dir mkdir fails mid-write,
  // after the package copy already happened.
  writeFileSync(path.join(destination, 'indexes'), 'not-a-directory\n');
  git(destination, ['add', 'indexes']);
  git(destination, ['commit', '-q', '-m', 'chore: block indexes dir']);

  assert.throws(
    () => writeLearningPackage({ packageDir: result.packageDir, destination, consent: CONSENT }),
    /rolled back/,
  );
  assert.equal(
    existsSync(path.join(destination, 'packages')),
    false,
    'rollback should have removed the copied package from the destination',
  );
  assert.equal(readFileSync(path.join(destination, 'indexes'), 'utf8'), 'not-a-directory\n');
  assert.equal(
    git(destination, ['status', '--porcelain']),
    '',
    'rollback should have left the destination tree clean',
  );
  // The local assembled package is untouched and re-writable.
  assert.ok(existsSync(path.join(result.packageDir, 'manifest.json')));
});

test('destination-repo hooks are respected: a rejecting pre-commit hook rolls the write back', () => {
  const { result } = assembled();
  assert.equal(result.status, 'ok');
  if (result.status !== 'ok') return;
  const destination = initDestinationRepo();
  const hookPath = path.join(destination, '.git/hooks/pre-commit');
  writeFileSync(hookPath, '#!/bin/sh\necho "policy: rejected" >&2\nexit 1\n');
  chmodSync(hookPath, 0o755);

  assert.throws(
    () => writeLearningPackage({ packageDir: result.packageDir, destination, consent: CONSENT }),
    /rolled back/,
  );
  assert.equal(existsSync(path.join(destination, 'packages')), false);
  assert.equal(git(destination, ['status', '--porcelain']), '');
  // No commit was created.
  assert.equal(git(destination, ['rev-list', '--count', 'HEAD']), '1');
});
