import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeoutLearningPackage,
  type CloseoutMetadata,
  deriveCloseoutPackageId,
} from '../src/closeout/index.js';
import { validateLearningPackage } from '../src/validate/index.js';

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

function destinationRepo(): string {
  const destination = mkdtempSync(path.join(os.tmpdir(), 'handoff-closeout-destination-'));
  git(destination, ['init', '-q']);
  git(destination, ['config', 'user.email', 'test@example.invalid']);
  git(destination, ['config', 'user.name', 'Handoff Test']);
  writeFileSync(path.join(destination, 'README.md'), '# Learnings\n');
  git(destination, ['add', 'README.md']);
  git(destination, ['commit', '-q', '-m', 'chore: initialize']);
  return destination;
}

function directoryDigest(root: string): string {
  const hash = createHash('sha256');
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      if (entry.isDirectory()) {
        walk(absolute);
      } else {
        hash.update(relative);
        hash.update(readFileSync(absolute));
      }
    }
  };
  walk(root);
  return hash.digest('hex');
}

function scenario(
  options: {
    signalStatus?: string;
    signalOutcome?: string;
    learnings?: string;
    destination?: string;
  } = {},
): {
  taskDir: string;
  configPath: string;
  metadata: CloseoutMetadata;
} {
  const taskDir = mkdtempSync(path.join(os.tmpdir(), 'handoff-closeout-task-'));
  mkdirSync(path.join(taskDir, 'inputs'), { recursive: true });
  mkdirSync(path.join(taskDir, 'artifacts'), { recursive: true });
  writeFileSync(path.join(taskDir, 'CHECKLIST.md'), '# Task\n\nProve the behavior.\n');
  writeFileSync(path.join(taskDir, 'artifacts/report.md'), '# Report\n\nProven.\n');
  writeFileSync(
    path.join(taskDir, 'artifacts/learnings.md'),
    options.learnings ?? '# Learnings\n\n- [harness] Keep capture separate from analysis.\n',
  );
  writeFileSync(
    path.join(taskDir, 'SIGNAL.json'),
    `${JSON.stringify(
      {
        status: options.signalStatus ?? 'complete',
        outcome: options.signalOutcome ?? 'success',
        timestamp: '2026-07-20T21:45:00Z',
      },
      null,
      2,
    )}\n`,
  );
  const metadata: CloseoutMetadata = {
    schemaVersion: 1,
    attemptId: 'attempt-1',
    surface: 'skill',
    project: 'metamask-mobile',
    repo: 'MetaMask/metamask-mobile',
    domain: 'perps',
    flow: 'fix-bug',
    startedAt: '2026-07-20T20:21:41Z',
    task: {
      title: 'Prove Perps telemetry integrity',
      sourceKind: 'jira',
      ticket: 'EX-1234',
      sourceRef: 'https://example.invalid/browse/EX-1234',
    },
    taskDocument: 'CHECKLIST.md',
    report: 'artifacts/report.md',
    learnings: 'artifacts/learnings.md',
  };
  writeFileSync(
    path.join(taskDir, 'inputs/handoff.json'),
    `${JSON.stringify(metadata, null, 2)}\n`,
  );
  const configPath = path.join(taskDir, 'learning.config.json');
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        ...(options.destination === undefined ? {} : { destination: options.destination }),
      },
      null,
      2,
    )}\n`,
  );
  return { taskDir, configPath, metadata };
}

test('closeout stages a valid deterministic package without destination IO', () => {
  const { taskDir, configPath, metadata } = scenario();
  const result = closeoutLearningPackage({ taskDir, configPath });
  assert.equal(result.status, 'staged');
  if (result.status !== 'staged') return;
  assert.equal(path.basename(result.packageDir), deriveCloseoutPackageId(metadata));
  assert.match(result.wouldWritePath, /^packages\/2026\/07\/20\/skill\/metamask-mobile\//u);
  assert.equal(validateLearningPackage(result.packageDir).valid, true);
  assert.equal(
    readFileSync(path.join(result.packageDir, 'report.md'), 'utf8'),
    '# Report\n\nProven.\n',
  );
  const firstDigest = directoryDigest(result.packageDir);
  const restaged = closeoutLearningPackage({ taskDir, configPath });
  assert.equal(restaged.status, 'staged');
  if (restaged.status !== 'staged') return;
  assert.equal(directoryDigest(restaged.packageDir), firstDigest);
});

test('closeout omits local file source references from the portable package', () => {
  const { taskDir, configPath, metadata } = scenario();
  metadata.task = {
    title: 'Local task file',
    sourceKind: 'file',
    sourceRef: '/Users/alice/private/task.md',
  };
  metadata.source = {
    title: 'Local task file',
    sourceRef: '/Users/alice/private/task.md',
  };
  writeFileSync(
    path.join(taskDir, 'inputs/handoff.json'),
    `${JSON.stringify(metadata, null, 2)}\n`,
  );

  const result = closeoutLearningPackage({ taskDir, configPath });
  assert.equal(result.status, 'staged');
  if (result.status !== 'staged') return;
  const manifest = JSON.parse(
    readFileSync(path.join(result.packageDir, 'manifest.json'), 'utf8'),
  ) as {
    task: { sourceRef?: string };
  };
  const source = JSON.parse(readFileSync(path.join(result.packageDir, 'source.json'), 'utf8')) as {
    sourceRef?: string;
  };
  assert.equal(manifest.task.sourceRef, undefined);
  assert.equal(source.sourceRef, undefined);
  assert.doesNotMatch(JSON.stringify({ manifest, source }), /\/Users\/alice\/private/u);
});

test('independent attempts started in the same second receive distinct package ids', () => {
  const first = scenario().metadata;
  const second = { ...first, attemptId: 'attempt-2' };
  assert.notEqual(deriveCloseoutPackageId(first), deriveCloseoutPackageId(second));
});

test('closeout refuses an unfinished task before assembly', () => {
  const { taskDir, configPath } = scenario({ signalStatus: 'running' });
  assert.throws(
    () => closeoutLearningPackage({ taskDir, configPath }),
    /run \.\/mark complete before closeout/u,
  );
  assert.equal(existsSync(path.join(taskDir, '.handoff', 'packages')), false);
});

test('closeout quarantines a floor secret and cannot share it', () => {
  const tempInputsBefore = new Set(
    readdirSync(os.tmpdir()).filter((entry) => entry.startsWith('handoff-closeout-inputs-')),
  );
  const destination = destinationRepo();
  const { taskDir, configPath } = scenario({
    destination,
    learnings:
      '# Learnings\n\nabandon ability able about above absent absorb abstract absurd abuse access accident\n',
  });
  const result = closeoutLearningPackage({
    taskDir,
    configPath,
  });
  assert.equal(result.status, 'blocked');
  if (result.status !== 'blocked') return;
  assert.deepEqual(
    git(destination, ['log', '--format=%s']),
    'chore: initialize',
    'blocked closeout must not write or commit',
  );
  assert.equal(existsSync(path.join(destination, 'packages')), false);
  assert.equal(existsSync(path.join(taskDir, '.handoff', 'inputs')), false);
  assert.deepEqual(
    readdirSync(os.tmpdir()).filter(
      (entry) => entry.startsWith('handoff-closeout-inputs-') && !tempInputsBefore.has(entry),
    ),
    [],
  );
  const taskText = readdirSync(taskDir, { recursive: true })
    .filter((entry) => typeof entry === 'string')
    .map((entry) => path.join(taskDir, entry))
    .filter((entry) => {
      try {
        return !entry.endsWith('learnings.md') && readFileSync(entry).length > 0;
      } catch {
        return false;
      }
    })
    .map((entry) => readFileSync(entry, 'utf8'))
    .join('\n');
  assert.doesNotMatch(taskText, /abandon ability able about above absent/u);
});

test('sharing requires a previously staged package', () => {
  const destination = destinationRepo();
  const { taskDir, configPath } = scenario({ destination });
  assert.throws(
    () => closeoutLearningPackage({ taskDir, configPath, share: true }),
    /no valid staged package exists/u,
  );
  assert.equal(existsSync(path.join(destination, 'packages')), false);
});

test('explicit share writes once and identical retry is idempotent', () => {
  const destination = destinationRepo();
  const { taskDir, configPath } = scenario({ destination });
  closeoutLearningPackage({ taskDir, configPath });
  const first = closeoutLearningPackage({
    taskDir,
    configPath,
    share: true,
  });
  assert.equal(first.status, 'written');
  if (first.status !== 'written') return;
  assert.equal(first.pushed, false);
  assert.equal(git(destination, ['status', '--porcelain']), '');
  assert.equal(validateLearningPackage(first.destinationPath).valid, true);

  const retry = closeoutLearningPackage({
    taskDir,
    configPath,
    share: true,
  });
  assert.equal(retry.status, 'already-shared');
  assert.equal(git(destination, ['log', '--format=%s']).split('\n').length, 2);
});

test('idempotent explicit-share retry pushes a commit after the first push failed', () => {
  const remote = mkdtempSync(path.join(os.tmpdir(), 'handoff-closeout-remote-'));
  git(remote, ['init', '--bare', '-q']);
  const destination = destinationRepo();
  git(destination, ['remote', 'add', 'origin', remote]);
  git(destination, ['push', '-q', '-u', 'origin', 'HEAD']);
  git(destination, ['remote', 'set-url', 'origin', `${remote}-missing`]);

  const { taskDir, configPath } = scenario({ destination });
  closeoutLearningPackage({ taskDir, configPath });
  const first = closeoutLearningPackage({
    taskDir,
    configPath,
    share: true,
  });
  assert.equal(first.status, 'written');
  if (first.status !== 'written') return;
  assert.equal(first.pushed, false);
  assert.ok(first.pushError);

  git(destination, ['remote', 'set-url', 'origin', remote]);
  const retry = closeoutLearningPackage({
    taskDir,
    configPath,
    share: true,
  });
  assert.equal(retry.status, 'already-shared');
  if (retry.status !== 'already-shared') return;
  assert.equal(retry.pushed, true);
  assert.equal(retry.pushError, undefined);
  assert.equal(git(remote, ['rev-parse', 'HEAD']), git(destination, ['rev-parse', 'HEAD']));
});

test('explicit share publishes the inspected staged bytes, not later task edits', () => {
  const destination = destinationRepo();
  const { taskDir, configPath } = scenario({ destination });
  const staged = closeoutLearningPackage({ taskDir, configPath });
  assert.equal(staged.status, 'staged');
  writeFileSync(path.join(taskDir, 'artifacts/report.md'), '# Report\n\nChanged later.\n');
  const written = closeoutLearningPackage({
    taskDir,
    configPath,
    share: true,
  });
  assert.equal(written.status, 'written');
  if (written.status !== 'written') return;
  assert.equal(
    readFileSync(path.join(written.destinationPath, 'report.md'), 'utf8'),
    '# Report\n\nProven.\n',
  );
});

test('same package id with newly staged content refuses append-only divergence', () => {
  const destination = destinationRepo();
  const { taskDir, configPath } = scenario({ destination });
  closeoutLearningPackage({ taskDir, configPath });
  closeoutLearningPackage({
    taskDir,
    configPath,
    share: true,
  });
  const commitsBefore = git(destination, ['rev-list', '--count', 'HEAD']);
  writeFileSync(path.join(taskDir, 'artifacts/report.md'), '# Report\n\nDifferent proof.\n');
  closeoutLearningPackage({ taskDir, configPath });
  assert.throws(
    () =>
      closeoutLearningPackage({
        taskDir,
        configPath,
        share: true,
      }),
    /not the identical, fully committed and indexed transaction/u,
  );
  assert.equal(git(destination, ['rev-list', '--count', 'HEAD']), commitsBefore);
});

test('copied package without a committed index transaction is not already shared', () => {
  const destination = destinationRepo();
  const { taskDir, configPath } = scenario({ destination });
  const staged = closeoutLearningPackage({ taskDir, configPath });
  assert.equal(staged.status, 'staged');
  if (staged.status !== 'staged') return;
  const copied = path.join(destination, staged.wouldWritePath);
  mkdirSync(path.dirname(copied), { recursive: true });
  cpSync(staged.packageDir, copied, { recursive: true });
  git(destination, ['add', '.']);
  git(destination, ['commit', '-q', '-m', 'chore: copy incomplete package']);
  assert.throws(
    () =>
      closeoutLearningPackage({
        taskDir,
        configPath,
        share: true,
      }),
    /not the identical, fully committed and indexed transaction/u,
  );
});

test('ignored untracked indexes cannot masquerade as an already-shared transaction', () => {
  const destination = destinationRepo();
  const { taskDir, configPath } = scenario({ destination });
  closeoutLearningPackage({ taskDir, configPath });
  closeoutLearningPackage({
    taskDir,
    configPath,
    share: true,
  });
  git(destination, ['rm', '-q', '--cached', '-r', 'indexes']);
  writeFileSync(path.join(destination, '.gitignore'), 'indexes/\n');
  git(destination, ['add', '.gitignore']);
  git(destination, ['commit', '-q', '-m', 'test: ignore indexes']);
  assert.equal(git(destination, ['status', '--porcelain']), '');
  assert.equal(git(destination, ['ls-files', 'indexes']), '');
  assert.throws(
    () =>
      closeoutLearningPackage({
        taskDir,
        configPath,
        share: true,
      }),
    /not the identical, fully committed and indexed transaction/u,
  );
});

test('malformed committed index data fails with closeout recovery guidance', () => {
  const destination = destinationRepo();
  const { taskDir, configPath } = scenario({ destination });
  closeoutLearningPackage({ taskDir, configPath });
  closeoutLearningPackage({
    taskDir,
    configPath,
    share: true,
  });
  const indexFile = path.join(destination, 'indexes/by-project/metamask-mobile.jsonl');
  appendFileSync(indexFile, '{not-json}\n');
  git(destination, ['add', indexFile]);
  git(destination, ['commit', '-q', '-m', 'test: corrupt an index']);
  assert.throws(
    () =>
      closeoutLearningPackage({
        taskDir,
        configPath,
        share: true,
      }),
    /Nothing was overwritten\. Next: inspect the destination package and indexes/u,
  );
});

test('idempotent share reasserts the secret floor before returning success', () => {
  const destination = destinationRepo();
  const { taskDir, configPath } = scenario({ destination });
  closeoutLearningPackage({ taskDir, configPath });
  const first = closeoutLearningPackage({
    taskDir,
    configPath,
    share: true,
  });
  assert.equal(first.status, 'written');
  if (first.status !== 'written') return;
  const stagedPackage = first.packageDir;
  const planted =
    '# Report\n\nprivate_key=0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n';
  for (const packageDir of [stagedPackage, first.destinationPath]) {
    writeFileSync(path.join(packageDir, 'report.md'), planted);
    const manifestPath = path.join(packageDir, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      files: Record<string, { sha256: string }>;
    };
    manifest.files['report.md'].sha256 = createHash('sha256').update(planted).digest('hex');
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  git(destination, ['add', '.']);
  git(destination, ['commit', '-q', '-m', 'test: plant hash-consistent secret']);
  assert.throws(
    () =>
      closeoutLearningPackage({
        taskDir,
        configPath,
        share: true,
      }),
    /existing package report\.md carries 1 secret/u,
  );
});

test('stale terminal signal from a reused task directory is refused', () => {
  const { taskDir, configPath } = scenario();
  writeFileSync(
    path.join(taskDir, 'SIGNAL.json'),
    `${JSON.stringify(
      {
        status: 'complete',
        outcome: 'success',
        timestamp: '2026-07-20T19:00:00Z',
      },
      null,
      2,
    )}\n`,
  );
  assert.throws(
    () => closeoutLearningPackage({ taskDir, configPath }),
    /do not reuse a task directory/u,
  );
});

test('terminal signal report path supports no-change closeout', () => {
  const { taskDir, configPath } = scenario();
  writeFileSync(
    path.join(taskDir, 'artifacts/no-change-report.md'),
    '# No change\n\nAlready fixed.\n',
  );
  writeFileSync(
    path.join(taskDir, 'SIGNAL.json'),
    `${JSON.stringify(
      {
        status: 'complete',
        outcome: 'success',
        disposition: 'no-change',
        timestamp: '2026-07-20T21:45:00Z',
        evidence: { reportPath: 'artifacts/no-change-report.md' },
      },
      null,
      2,
    )}\n`,
  );
  const result = closeoutLearningPackage({ taskDir, configPath });
  assert.equal(result.status, 'staged');
  if (result.status !== 'staged') return;
  assert.equal(
    readFileSync(path.join(result.packageDir, 'report.md'), 'utf8'),
    '# No change\n\nAlready fixed.\n',
  );
});

test('repository metadata is reduced to a portable slug without credentials', () => {
  const { taskDir, configPath } = scenario();
  const metadataPath = path.join(taskDir, 'inputs/handoff.json');
  const metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as CloseoutMetadata;
  metadata.repo = 'https://x-access-token:secret-value@example.invalid/team/repo.git';
  writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  const result = closeoutLearningPackage({ taskDir, configPath });
  assert.equal(result.status, 'staged');
  if (result.status !== 'staged') return;
  const manifest = JSON.parse(
    readFileSync(path.join(result.packageDir, 'manifest.json'), 'utf8'),
  ) as { repo?: string };
  assert.equal(manifest.repo, 'team/repo');
});

test('local repository paths are omitted and SCP identities lose the user prefix', () => {
  const local = scenario();
  local.metadata.repo = '/Users/alice/work/private-repo.git';
  writeFileSync(
    path.join(local.taskDir, 'inputs/handoff.json'),
    `${JSON.stringify(local.metadata, null, 2)}\n`,
  );
  const localResult = closeoutLearningPackage({
    taskDir: local.taskDir,
    configPath: local.configPath,
  });
  assert.equal(localResult.status, 'staged');
  if (localResult.status !== 'staged') return;
  const localManifest = JSON.parse(
    readFileSync(path.join(localResult.packageDir, 'manifest.json'), 'utf8'),
  ) as { repo?: string };
  assert.equal(localManifest.repo, undefined);

  const scp = scenario();
  scp.metadata.repo = 'git@example.invalid:MetaMask/metamask-mobile.git';
  writeFileSync(
    path.join(scp.taskDir, 'inputs/handoff.json'),
    `${JSON.stringify(scp.metadata, null, 2)}\n`,
  );
  const scpResult = closeoutLearningPackage({
    taskDir: scp.taskDir,
    configPath: scp.configPath,
  });
  assert.equal(scpResult.status, 'staged');
  if (scpResult.status !== 'staged') return;
  const scpManifest = JSON.parse(
    readFileSync(path.join(scpResult.packageDir, 'manifest.json'), 'utf8'),
  ) as { repo?: string };
  assert.equal(scpManifest.repo, 'MetaMask/metamask-mobile');
});

test('task-local input paths cannot escape the task directory', () => {
  const { taskDir, configPath } = scenario();
  const metadataPath = path.join(taskDir, 'inputs/handoff.json');
  const metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as CloseoutMetadata;
  metadata.report = '../outside.md';
  writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  assert.throws(
    () => closeoutLearningPackage({ taskDir, configPath }),
    /run report escapes the task directory/u,
  );
});

test('task-local input paths cannot escape through an ancestor symlink', () => {
  const { taskDir, configPath } = scenario();
  const outside = mkdtempSync(path.join(os.tmpdir(), 'handoff-closeout-outside-'));
  writeFileSync(path.join(outside, 'report.md'), '# Outside\n');
  symlinkSync(outside, path.join(taskDir, 'linked-artifacts'));
  const metadataPath = path.join(taskDir, 'inputs/handoff.json');
  const metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as CloseoutMetadata;
  metadata.report = 'linked-artifacts/report.md';
  writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  assert.throws(
    () => closeoutLearningPackage({ taskDir, configPath }),
    /run report resolves outside the task directory/u,
  );
});

test('task-local staging cannot escape through a pre-existing .handoff symlink', () => {
  const { taskDir, configPath } = scenario();
  const outside = mkdtempSync(path.join(os.tmpdir(), 'handoff-closeout-stage-outside-'));
  symlinkSync(outside, path.join(taskDir, '.handoff'));
  assert.throws(
    () => closeoutLearningPackage({ taskDir, configPath }),
    /task staging root must be a real directory inside the task/u,
  );
  assert.deepEqual(readdirSync(outside), []);
});

test('missing config still stages locally', () => {
  const { taskDir, metadata } = scenario();
  const configPath = path.join(taskDir, 'missing', 'learning.config.json');
  const result = closeoutLearningPackage({ taskDir, configPath });
  assert.equal(result.status, 'staged');
  if (result.status !== 'staged') return;
  const manifest = JSON.parse(
    readFileSync(path.join(result.packageDir, 'manifest.json'), 'utf8'),
  ) as { packageId?: string };
  assert.equal(manifest.packageId, deriveCloseoutPackageId(metadata));
});

test('relative destination resolves from the config directory', () => {
  const destination = destinationRepo();
  const { taskDir, configPath } = scenario();
  const configDir = path.dirname(configPath);
  const relativeDestination = path.relative(configDir, destination);
  writeFileSync(
    configPath,
    `${JSON.stringify({ schemaVersion: 1, destination: relativeDestination }, null, 2)}\n`,
  );
  closeoutLearningPackage({ taskDir, configPath });
  const result = closeoutLearningPackage({
    taskDir,
    configPath,
    share: true,
  });
  assert.equal(result.status, 'written');
});

test('explicit farm configs isolate their destination repositories', () => {
  const firstDestination = destinationRepo();
  const secondDestination = destinationRepo();
  const { taskDir, configPath } = scenario({ destination: firstDestination });
  const secondConfigPath = path.join(path.dirname(configPath), 'second-farm.json');
  writeFileSync(
    secondConfigPath,
    `${JSON.stringify({ schemaVersion: 1, destination: secondDestination }, null, 2)}\n`,
  );

  closeoutLearningPackage({ taskDir, configPath });
  const first = closeoutLearningPackage({ taskDir, configPath, share: true });
  const second = closeoutLearningPackage({
    taskDir,
    configPath: secondConfigPath,
    share: true,
  });

  assert.equal(first.status, 'written');
  assert.equal(second.status, 'written');
  if (first.status !== 'written' || second.status !== 'written') return;
  assert.notEqual(first.destinationPath, second.destinationPath);
  assert.ok(existsSync(first.destinationPath));
  assert.ok(existsSync(second.destinationPath));
});

test('--json parse errors use the stable error envelope', () => {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'src/bin/handoff.ts', 'closeout', '--json'],
    {
      cwd: path.resolve(import.meta.dirname, '..'),
      encoding: 'utf8',
    },
  );
  assert.equal(result.status, 1);
  assert.equal(result.stderr, '');
  const output = JSON.parse(result.stdout) as {
    status: string;
    error: { code: string; message: string; userAction: string };
  };
  assert.equal(output.status, 'error');
  assert.equal(output.error.code, 'HANDOFF_CLOSEOUT_FAILED');
  assert.match(output.error.message, /Missing <task-dir>/u);
  assert.match(output.error.userAction, /Usage:/u);
});
