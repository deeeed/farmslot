import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
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

test('destination writes are serialized by a lock: held lock refuses with escape guidance', () => {
  const { result } = assembled();
  assert.equal(result.status, 'ok');
  if (result.status !== 'ok') return;
  const destination = initDestinationRepo();
  const lockPath = path.join(destination, '.git/farmslot-handoff.lock');
  writeFileSync(lockPath, '{"pid":99999,"startedAt":"2026-07-13T10:00:00Z"}\n');

  // A held lock refuses the write and teaches the stale-lock escape.
  assert.throws(
    () => writeLearningPackage({ packageDir: result.packageDir, destination, consent: CONSENT }),
    (error: Error) => {
      assert.match(error.message, /another write .* is in progress/);
      assert.match(error.message, /stale lock/);
      assert.match(error.message, /Next:/);
      return true;
    },
  );
  assert.equal(existsSync(path.join(destination, 'packages')), false);

  // Removing the stale lock unblocks the writer; the lock is released after.
  rmSync(lockPath);
  const write = writeLearningPackage({
    packageDir: result.packageDir,
    destination,
    consent: CONSENT,
  });
  assert.equal(write.status, 'written');
  assert.equal(existsSync(lockPath), false, 'lock not released after a successful write');
});

test('the lock is released after a failed (rolled back) write too', () => {
  const { result } = assembled();
  assert.equal(result.status, 'ok');
  if (result.status !== 'ok') return;
  const destination = initDestinationRepo();
  const hookPath = path.join(destination, '.git/hooks/pre-commit');
  writeFileSync(hookPath, '#!/bin/sh\nexit 1\n');
  chmodSync(hookPath, 0o755);

  assert.throws(
    () => writeLearningPackage({ packageDir: result.packageDir, destination, consent: CONSENT }),
    /rolled back/,
  );
  assert.equal(
    existsSync(path.join(destination, '.git/farmslot-handoff.lock')),
    false,
    'lock not released after a rolled-back write',
  );

  // With the hook gone, back-to-back writes of two packages both land intact.
  rmSync(hookPath);
  const first = writeLearningPackage({
    packageDir: result.packageDir,
    destination,
    consent: CONSENT,
  });
  assert.equal(first.status, 'written');

  const second = assembled();
  assert.equal(second.result.status, 'ok');
  if (second.result.status !== 'ok') return;
  const manifestPath = path.join(second.result.packageDir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { packageId: string };
  manifest.packageId = '20260703T180000Z-fleet-dev-proj-123-0000ffff';
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const secondWrite = writeLearningPackage({
    packageDir: second.result.packageDir,
    destination,
    consent: CONSENT,
  });
  assert.equal(secondWrite.status, 'written');

  const family = readFileSync(path.join(destination, 'indexes/by-task/proj-123.jsonl'), 'utf8')
    .trim()
    .split('\n');
  assert.equal(family.length, 2, 'both writers rows must be intact');
  assert.equal(existsSync(path.join(destination, '.git/farmslot-handoff.lock')), false);
});

test('a linked git worktree is a valid destination (.git is a file, not a dir)', () => {
  const { result } = assembled();
  assert.equal(result.status, 'ok');
  if (result.status !== 'ok') return;

  const mainRepo = initDestinationRepo();
  const worktree = path.join(path.dirname(mainRepo), `wt-${Date.now().toString(36)}`);
  git(mainRepo, ['worktree', 'add', '-b', 'lane', worktree]);
  try {
    // Sanity: in a linked worktree, .git is a FILE with a gitdir pointer.
    assert.ok(readFileSync(path.join(worktree, '.git'), 'utf8').startsWith('gitdir:'));

    const write = writeLearningPackage({
      packageDir: result.packageDir,
      destination: worktree,
      consent: CONSENT,
    });
    assert.equal(write.status, 'written');
    if (write.status !== 'written') return;
    assert.ok(existsSync(path.join(write.destinationPath, 'manifest.json')));
    assert.equal(git(worktree, ['status', '--porcelain']), '');
    // The lock lived in the resolved git dir and is gone after the write.
    const gitDir = readFileSync(path.join(worktree, '.git'), 'utf8')
      .replace(/^gitdir:\s*/, '')
      .trim();
    assert.equal(existsSync(path.join(gitDir, 'farmslot-handoff.lock')), false);
  } finally {
    git(mainRepo, ['worktree', 'remove', '--force', worktree]);
  }
});

test('runtime consent validation names each missing field for untyped callers', () => {
  const { result } = assembled();
  assert.equal(result.status, 'ok');
  if (result.status !== 'ok') return;
  const destination = initDestinationRepo();
  const attempt = (consent: unknown): void => {
    writeLearningPackage({
      packageDir: result.packageDir,
      destination,
      consent: consent as typeof CONSENT,
    });
  };

  assert.throws(() => attempt({ humanApproval: true, grantedAt: CONSENT.grantedAt }), /approvedBy/);
  assert.throws(
    () => attempt({ humanApproval: true, approvedBy: '   ', grantedAt: CONSENT.grantedAt }),
    /approvedBy/,
  );
  assert.throws(() => attempt({ humanApproval: true, approvedBy: 'eng-1' }), /grantedAt/);
  assert.throws(
    () => attempt({ humanApproval: true, approvedBy: 'eng-1', grantedAt: 'yesterday' }),
    /grantedAt/,
  );
  assert.equal(existsSync(path.join(destination, 'packages')), false);

  // The complete consent still writes.
  const write = writeLearningPackage({
    packageDir: result.packageDir,
    destination,
    consent: CONSENT,
  });
  assert.equal(write.status, 'written');
});

test('the committed package is a validated snapshot, decoupled from the source dir', () => {
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

  const committed = readFileSync(path.join(write.destinationPath, 'report.md'), 'utf8');

  // Mutating the SOURCE after the write must not affect the committed bytes:
  // the destination received the validated snapshot, never the live source.
  writeFileSync(path.join(result.packageDir, 'report.md'), '# Report\n\nMUTATED after write.\n');
  assert.equal(
    readFileSync(path.join(write.destinationPath, 'report.md'), 'utf8'),
    committed,
    'committed bytes tracked a post-write source mutation',
  );
  assert.equal(committed.includes('MUTATED'), false);

  // No snapshot staging dir leaks into the OS tmp area.
  const leaked = readdirSync(os.tmpdir()).filter((n) => n.startsWith('handoff-write-snapshot-'));
  assert.deepEqual(leaked, [], `snapshot staging dirs leaked: ${leaked.join(', ')}`);
});

test('a package whose file is tampered off its manifest hash is refused (snapshot validated)', () => {
  const { result } = assembled();
  assert.equal(result.status, 'ok');
  if (result.status !== 'ok') return;
  // Tamper a file without updating the manifest hash: the snapshot validation
  // (and the source pre-validation) both reject the hash mismatch.
  writeFileSync(path.join(result.packageDir, 'learnings.md'), '# Learnings\n\nTampered.\n');
  const destination = initDestinationRepo();
  assert.throws(
    () => writeLearningPackage({ packageDir: result.packageDir, destination, consent: CONSENT }),
    /sha256 mismatch|snapshot failed validation/,
  );
  assert.equal(existsSync(path.join(destination, 'packages')), false);
});

test('a post-assemble tampered text file (token + updated manifest hash, status pass) is refused', () => {
  const { result } = assembled();
  assert.equal(result.status, 'ok');
  if (result.status !== 'ok') return;

  // Tamper report.md with a token, then update the manifest hash to match and
  // leave scrubbing.status "pass" - schema + hash validation would pass, so
  // the write-side floor rescan is the only thing that catches the secret.
  const tampered = `# Report\n\nleaked ghp_${'a'.repeat(36)} in the log\n`;
  const reportPath = path.join(result.packageDir, 'report.md');
  writeFileSync(reportPath, tampered);
  const manifestPath = path.join(result.packageDir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    files: Record<string, { sha256: string; bytes: number; role: string }>;
  };
  manifest.files['report.md'].sha256 = createHash('sha256').update(tampered).digest('hex');
  manifest.files['report.md'].bytes = Buffer.byteLength(tampered);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const destination = initDestinationRepo();
  assert.throws(
    () => writeLearningPackage({ packageDir: result.packageDir, destination, consent: CONSENT }),
    /report\.md carries \d+ secret/,
  );
  assert.equal(existsSync(path.join(destination, 'packages')), false);
  assert.equal(git(destination, ['status', '--porcelain']), '');
});

test('a clean package still writes after the write-side floor rescan', () => {
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
});
