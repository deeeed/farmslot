import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
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

test('a planted symlink inside a staged package refuses the write; nothing is copied', () => {
  const { ctx, input } = scenario();
  const result = assembleLearningPackage(input, ctx);
  assert.equal(result.status, 'ok');
  if (result.status !== 'ok') return;

  // Post-assembly tamper: a symlink pointing at an outside secret file.
  const outsideSecret = path.join(mkdtempSync(path.join(os.tmpdir(), 'handoff-secret-')), 's.md');
  writeFileSync(outsideSecret, 'outside-secret-content\n');
  symlinkSync(outsideSecret, path.join(result.packageDir, 'linked.md'));

  const destination = initDestinationRepo();
  assert.throws(
    () => writeLearningPackage({ packageDir: result.packageDir, destination, consent: CONSENT }),
    /non-regular-file/,
  );
  assert.equal(existsSync(path.join(destination, 'packages')), false);
  assert.equal(git(destination, ['status', '--porcelain']), '');
});

test('metadata secrets block assembly and the quarantine manifest never carries them raw', () => {
  const srp =
    'abandon ability able about above absent absorb abstract absurd abuse access accident';
  const titleCase = scenario();
  titleCase.input.runRecord.task.title = `restore with ${srp}`;
  const blockedByTitle = assembleLearningPackage(titleCase.input, titleCase.ctx);
  assert.equal(blockedByTitle.status, 'blocked');
  if (blockedByTitle.status !== 'blocked') return;
  assert.ok(
    blockedByTitle.scrubReport.blocked.some((b) => b.file === 'manifest.json' && b.kind === 'srp'),
  );
  const quarantined = readFileSync(
    path.join(blockedByTitle.quarantineDir, 'manifest.json'),
    'utf8',
  );
  assert.equal(quarantined.includes(srp), false, 'quarantine manifest carries the raw SRP');
  assert.ok(quarantined.includes('[REDACTED:srp]'));

  const extCase = scenario();
  extCase.input.runRecord.extensions = { note: `token ghp_${'a'.repeat(36)}` };
  const blockedByExtension = assembleLearningPackage(extCase.input, extCase.ctx);
  assert.equal(blockedByExtension.status, 'blocked');
  if (blockedByExtension.status !== 'blocked') return;
  assert.ok(
    blockedByExtension.scrubReport.blocked.some(
      (b) => b.file === 'manifest.json' && b.kind === 'github-token',
    ),
  );
  assert.equal(
    readFileSync(path.join(blockedByExtension.quarantineDir, 'manifest.json'), 'utf8').includes(
      `ghp_${'a'.repeat(36)}`,
    ),
    false,
  );
});

test('end-to-end: a punctuation-only ticket assembles and writes under the content-hash family', () => {
  const { ctx, input } = scenario();
  input.runRecord.task.ticket = '!!!';
  const result = assembleLearningPackage(input, ctx);
  assert.equal(result.status, 'ok');
  if (result.status !== 'ok') return;
  assert.match(result.manifest.taskKey, /^task-[a-f0-9]{16}$/);
  assert.equal('ticket' in result.manifest.task, false, 'unusable ticket should be dropped');

  const destination = initDestinationRepo();
  const write = writeLearningPackage({
    packageDir: result.packageDir,
    destination,
    consent: CONSENT,
  });
  assert.equal(write.status, 'written');
  assert.ok(existsSync(path.join(destination, `indexes/by-task/${result.manifest.taskKey}.jsonl`)));
  assert.equal(existsSync(path.join(destination, 'indexes/by-ticket')), false);
});

test('a symlinked quarantine root cannot redirect the destructive rm or the audit writes', () => {
  const { ctx, input } = scenario(
    '# Learnings\n\nabandon ability able about above absent absorb abstract absurd abuse access accident\n',
  );
  const outside = mkdtempSync(path.join(os.tmpdir(), 'handoff-outside-q-'));
  writeFileSync(path.join(outside, 'precious.md'), 'do not delete\n');
  symlinkSync(outside, path.join(ctx.stagingRoot, 'quarantine'));

  assert.throws(() => assembleLearningPackage(input, ctx), /escapes its root/);
  assert.ok(existsSync(path.join(outside, 'precious.md')), 'outside content was destroyed');
  assert.equal(existsSync(path.join(outside, input.runRecord.packageId)), false);
});

test('a symlinked staging path cannot redirect package staging', () => {
  const { ctx, input } = scenario();
  const outside = mkdtempSync(path.join(os.tmpdir(), 'handoff-outside-s-'));
  symlinkSync(outside, path.join(ctx.stagingRoot, input.runRecord.packageId));
  assert.throws(() => assembleLearningPackage(input, ctx), /escapes its root/);
  assert.deepEqual(readdirSync(outside), []);
});

test('a rollback that cannot restore the destination throws a distinct partial-state error', () => {
  const { ctx, input } = scenario();
  const result = assembleLearningPackage(input, ctx);
  assert.equal(result.status, 'ok');
  if (result.status !== 'ok') return;
  assert.ok(ctx.stagingRoot);

  const destination = initDestinationRepo();
  // An empty DIRECTORY at an index-file path: invisible to git status (clean
  // tree), fails appendFileSync mid-write, and fails truncateSync in rollback.
  mkdirSync(path.join(destination, 'indexes/by-engineer/eng-1.jsonl'), { recursive: true });

  assert.throws(
    () => writeLearningPackage({ packageDir: result.packageDir, destination, consent: CONSENT }),
    (error: Error) => {
      assert.match(error.message, /could not fully restore/);
      assert.match(error.message, /Partial state may remain/);
      assert.match(error.message, /Next:/);
      assert.doesNotMatch(error.message, /was rolled back/);
      return true;
    },
  );
});

test('caller strings that land in written files are floor-gated: filenames and attestations', () => {
  const srpPath =
    'notes/abandon ability able about above absent absorb abstract absurd abuse access accident.md';
  const fileNameCase = scenario();
  const shotA = path.join(fileNameCase.ctx.workspace as string, 'a.png');
  writeFileSync(shotA, 'png-bytes');
  fileNameCase.input.media = [
    {
      absolutePath: shotA,
      packagePath: srpPath,
      kind: 'screenshot',
      evidenceManifestSelected: false,
    },
  ];
  const blockedByPath = assembleLearningPackage(fileNameCase.input, fileNameCase.ctx);
  assert.equal(blockedByPath.status, 'blocked');
  if (blockedByPath.status !== 'blocked') return;
  assert.ok(
    blockedByPath.scrubReport.blocked.some((b) => b.file === 'input-metadata' && b.kind === 'srp'),
  );
  // The quarantined report never echoes the secret-bearing path raw.
  const report = readFileSync(path.join(blockedByPath.quarantineDir, 'scrub-report.json'), 'utf8');
  assert.equal(report.includes('abandon ability able'), false);

  const attestedCase = scenario();
  const shotB = path.join(attestedCase.ctx.workspace as string, 'b.png');
  writeFileSync(shotB, 'png-bytes');
  const token = `ghp_${'a'.repeat(36)}`;
  attestedCase.input.media = [
    {
      absolutePath: shotB,
      packagePath: 'harness/x/b.png',
      kind: 'screenshot',
      evidenceManifestSelected: true,
      visualPass: {
        file: 'harness/x/b.png',
        passedAt: '2026-07-13T13:00:00Z',
        attestedBy: `agent ${token}`,
        finding: 'clear',
      },
    },
  ];
  const blockedByAttestation = assembleLearningPackage(attestedCase.input, attestedCase.ctx);
  assert.equal(blockedByAttestation.status, 'blocked');
  if (blockedByAttestation.status !== 'blocked') return;
  assert.ok(
    blockedByAttestation.scrubReport.blocked.some(
      (b) => b.file === 'input-metadata' && b.kind === 'github-token',
    ),
  );
  assert.equal(
    readFileSync(
      path.join(blockedByAttestation.quarantineDir, 'scrub-report.json'),
      'utf8',
    ).includes(token),
    false,
  );
});

test('quarantine redaction covers object KEYS and mnemonics split across array values', () => {
  const token = `ghp_${'b'.repeat(36)}`;
  const words = [
    'abandon',
    'ability',
    'able',
    'about',
    'above',
    'absent',
    'absorb',
    'abstract',
    'absurd',
    'abuse',
    'access',
    'accident',
  ];
  const { ctx, input } = scenario();
  input.runRecord.extensions = { [token]: 'value-under-secret-key', mnemonicWords: words };
  const result = assembleLearningPackage(input, ctx);
  assert.equal(result.status, 'blocked');
  if (result.status !== 'blocked') return;
  const quarantined = readFileSync(path.join(result.quarantineDir, 'manifest.json'), 'utf8');
  assert.equal(quarantined.includes(token), false, 'secret KEY survived quarantine redaction');
  // No 12-word run survives in any form (per-element values would evade
  // per-value scanning; the array is redacted wholesale).
  assert.equal(quarantined.includes('"abandon"'), false);
  assert.ok(quarantined.includes('[REDACTED:srp]'));
});

test('an unreadable required document is a HARD assembly failure, never a silent omission', () => {
  const { ctx, input } = scenario();
  const learningsMd = path.join(input.artifacts.artifactsDir, 'learnings.md');
  chmodSync(learningsMd, 0o000);
  try {
    assert.throws(
      () => assembleLearningPackage(input, ctx),
      /required learnings\.md.*could not be read/,
    );
  } finally {
    chmodSync(learningsMd, 0o644);
  }
});

test('the write path can never derive NaN date segments', () => {
  const { ctx, input } = scenario();
  const result = assembleLearningPackage(input, ctx);
  assert.equal(result.status, 'ok');
  if (result.status !== 'ok') return;
  // Force an unparseable timestamp into the stored manifest (bypassing schema
  // validation is not possible on the write path - this asserts the belt-and-
  // braces guard message shape via the validator refusing first).
  const manifestPath = path.join(result.packageDir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    run: { startedAt: string };
  };
  manifest.run.startedAt = '2026-99-99T99:99:99Z';
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const destination = initDestinationRepo();
  assert.throws(
    () => writeLearningPackage({ packageDir: result.packageDir, destination, consent: CONSENT }),
    /invalid date-time|fails spec validation/,
  );
  assert.equal(existsSync(path.join(destination, 'packages')), false);
});

test('a binary (NUL-containing) required document is a hard assembly failure, never ok-with-7-files', () => {
  const { ctx, input } = scenario();
  writeFileSync(
    path.join(input.artifacts.artifactsDir, 'learnings.md'),
    `# Learnings${String.fromCharCode(0)}binary tail`,
  );
  assert.throws(
    () => assembleLearningPackage(input, ctx),
    /required file\(s\) missing.*learnings\.md \(unscannable\)/,
  );
  // Nothing half-assembled is left claiming ok status.
  assert.equal(
    existsSync(path.join(ctx.stagingRoot, input.runRecord.packageId, 'manifest.json')),
    true,
    'staging leftovers are local-only and harmless; manifest exists but assemble threw',
  );
});

test('the validator never follows in-package symlinks; write refuses them before validating', () => {
  const { ctx, input } = scenario();
  const result = assembleLearningPackage(input, ctx);
  assert.equal(result.status, 'ok');
  if (result.status !== 'ok') return;

  const outside = mkdtempSync(path.join(os.tmpdir(), 'handoff-sym-out-'));
  const outsideFile = path.join(outside, 'outside.md');
  writeFileSync(outsideFile, 'outside secret material\n');
  // Replace an inventoried required file with a symlink to the outside file.
  rmSync(path.join(result.packageDir, 'report.md'));
  symlinkSync(outsideFile, path.join(result.packageDir, 'report.md'));

  // Validator: collected error, no read/hash of the outside target.
  const validation = validateLearningPackage(result.packageDir);
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((e) => e.includes('report.md') && e.includes('symlink')));
  assert.equal(
    validation.errors.some((e) => e.includes('outside secret material')),
    false,
  );
  // The outside file's hash is never exposed via a mismatch message.
  assert.equal(
    validation.errors.some((e) => e.includes('sha256 mismatch')),
    false,
  );

  // Write: irregular-entry refusal comes FIRST, before any validation read.
  const destination = initDestinationRepo();
  assert.throws(
    () => writeLearningPackage({ packageDir: result.packageDir, destination, consent: CONSENT }),
    /non-regular-file/,
  );
});

test('quarantine audit never carries a mnemonic composed across separate metadata values', () => {
  // The package blocks for an unrelated reason (SRP in learnings); the
  // extensions carry a mnemonic split six+six across two values - each value
  // alone is below the run threshold, so only the joined view shows it.
  const { ctx, input } = scenario(
    '# Learnings\n\nabandon ability able about above absent absorb abstract absurd abuse access accident\n',
  );
  input.runRecord.extensions = {
    firstHalf: 'legal winner thank year wave sausage',
    secondHalf: 'worth useful legal winner thank year',
  };
  const result = assembleLearningPackage(input, ctx);
  assert.equal(result.status, 'blocked');
  if (result.status !== 'blocked') return;
  const quarantined = readFileSync(path.join(result.quarantineDir, 'manifest.json'), 'utf8');
  const hits = quarantined.match(/legal|winner|sausage/g) ?? [];
  assert.equal(hits.length, 0, 'cross-value mnemonic survived into the quarantine audit');
});

test('a token-shaped slug never becomes the quarantine directory name', () => {
  const { ctx, input } = scenario(
    '# Learnings\n\nabandon ability able about above absent absorb abstract absurd abuse access accident\n',
  );
  const token = `npm_${'a'.repeat(36)}`;
  input.runRecord.packageId = `run-${token}`;
  const result = assembleLearningPackage(input, ctx);
  assert.equal(result.status, 'blocked');
  if (result.status !== 'blocked') return;
  assert.equal(path.basename(result.quarantineDir).includes(token), false);
  assert.match(path.basename(result.quarantineDir), /^redacted-[a-f0-9]{8}$/);
});

test('a visual-pass attestation for a different file refuses assembly', () => {
  const { ctx, input } = scenario();
  const shot = path.join(ctx.workspace as string, 'shot.png');
  writeFileSync(shot, 'png-bytes');
  input.media = [
    {
      absolutePath: shot,
      packagePath: 'harness/x/shot.png',
      kind: 'screenshot',
      evidenceManifestSelected: true,
      visualPass: {
        file: 'harness/x/OTHER.png',
        passedAt: '2026-07-13T13:00:00Z',
        attestedBy: 'agent-model',
        finding: 'clear',
      },
    },
  ];
  assert.throws(() => assembleLearningPackage(input, ctx), /does not match its media packagePath/);
});

test('a same-id pass package is removed when reassembly blocks (stale-pass barrier)', () => {
  const { ctx, input } = scenario();
  const first = assembleLearningPackage(input, ctx);
  assert.equal(first.status, 'ok');
  if (first.status !== 'ok') return;
  assert.ok(existsSync(path.join(first.packageDir, 'manifest.json')));

  // Same id reassembled, now with a planted secret: the earlier pass package
  // must not survive beside the quarantine as a publishable stale artifact.
  writeFileSync(
    path.join(input.artifacts.artifactsDir, 'learnings.md'),
    '# Learnings\n\nabandon ability able about above absent absorb abstract absurd abuse access accident\n',
  );
  const second = assembleLearningPackage(input, ctx);
  assert.equal(second.status, 'blocked');
  assert.equal(
    existsSync(first.packageDir),
    false,
    'stale pass-status package survived a blocked reassembly',
  );
});

test('quarantine scrub-report never carries a mnemonic split across separate record paths', () => {
  const { ctx, input } = scenario();
  const half1 = path.join(ctx.workspace as string, 'h1.bin');
  const half2 = path.join(ctx.workspace as string, 'h2.bin');
  writeFileSync(half1, 'bytes');
  writeFileSync(half2, 'bytes');
  // Two disallowed media paths of six wordlist words each: each record alone
  // is below the run threshold, only the joined view shows the phrase.
  input.media = [
    {
      absolutePath: half1,
      packagePath: 'abandon ability able about above absent',
      kind: 'screenshot',
      evidenceManifestSelected: false,
    },
    {
      absolutePath: half2,
      packagePath: 'absorb abstract absurd abuse access accident',
      kind: 'screenshot',
      evidenceManifestSelected: false,
    },
  ];
  const result = assembleLearningPackage(input, ctx);
  assert.equal(result.status, 'blocked');
  if (result.status !== 'blocked') return;
  const report = readFileSync(path.join(result.quarantineDir, 'scrub-report.json'), 'utf8');
  const survivors = report.match(/abandon|ability|absorb|accident/g) ?? [];
  assert.equal(survivors.length, 0, 'cross-record mnemonic survived in the quarantine report');
  // The audit structure itself survives: reasons/kinds remain enumerable.
  assert.ok(report.includes('[REDACTED:entry-'));

  // The RETURNED report is the same sanitized object - a caller logging
  // result.scrubReport must never see the raw secret either.
  const returned = JSON.stringify(result.scrubReport);
  assert.equal(
    (returned.match(/abandon|ability|absorb|accident/g) ?? []).length,
    0,
    'cross-record mnemonic exposed on the returned scrubReport',
  );
  assert.ok(returned.includes('[REDACTED:entry-'));
  assert.ok(result.scrubReport.omitted.every((o) => o.path.startsWith('[REDACTED:entry-')));
});
