import assert from 'node:assert/strict';
import { exec as execCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { isFamilyDiffProvenance } from '@farmslot/protocol';

import { buildSourceDiffFilter } from '../core/source-diff-filter.js';

import {
  captureReviewInputArtifactsForRun,
  captureRunDiffArtifacts,
  parseGitNumstat,
  resolveReviewInputCaptureTimeoutMs,
  runSourceDiffUntrackedManifestCommand,
} from './diff-artifacts.js';
import { makeRun } from './test-fixtures.js';

const exec = promisify(execCallback);

test('untracked manifest command captures empty files, executable mode, and dangling symlinks', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'review-untracked-manifest-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await exec('git init -q', { cwd: dir });
  await writeFile(path.join(dir, 'empty file.ts'), '');
  await chmod(path.join(dir, 'empty file.ts'), 0o755);
  await symlink('missing-target', path.join(dir, 'dangling-link'));
  await symlink('target-with-newline\n', path.join(dir, '-leading-link'));

  const { stdout } = await exec(runSourceDiffUntrackedManifestCommand([]), { cwd: dir });
  const fields = stdout.split('\0').slice(0, -1);
  const files = [];
  for (let index = 0; index < fields.length; index += 3) {
    files.push({ mode: fields[index], blobSha: fields[index + 1], path: fields[index + 2] });
  }

  const byPath = new Map(files.map((file) => [file.path, file]));
  assert.deepEqual(byPath.get('dangling-link'), {
    mode: '120000',
    blobSha: '2050c51309015cf65b86e480b4d354ff82237eb7',
    path: 'dangling-link',
  });
  assert.deepEqual(byPath.get('empty file.ts'), {
    mode: '100755',
    blobSha: 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391',
    path: 'empty file.ts',
  });
  const newlineTarget = Buffer.from('target-with-newline\n');
  const newlineBlobSha = createHash('sha1')
    .update(`blob ${newlineTarget.length}\0`)
    .update(newlineTarget)
    .digest('hex');
  assert.deepEqual(byPath.get('-leading-link'), {
    mode: '120000',
    blobSha: newlineBlobSha,
    path: '-leading-link',
  });

  await chmod(path.join(dir, 'empty file.ts'), 0o644);
  const second = await exec(runSourceDiffUntrackedManifestCommand([]), { cwd: dir });
  assert.match(second.stdout, /100644\0e69de29bb2d1d6434b8b29ae775ad8c2e48c5391\0empty file\.ts\0/);
  assert.notEqual(second.stdout, stdout);
});

test('parseGitNumstat counts text and binary files without splitting paths containing spaces', () => {
  const numstat = [
    '12\t3\tsrc/normal.ts',
    '-\t-\tassets/icon file.png',
    '5\t0\tsrc/path with spaces.ts',
    '12\t3\tsrc/{old name.ts => new name.ts}',
    '0\t0\tsrc/mode-only.ts',
    '20\t1\tassets/generated.bin',
  ].join('\n');
  const stat = parseGitNumstat(numstat);
  const sourceStat = parseGitNumstat(numstat, { sourceOnly: true });
  const pngFilter = buildSourceDiffFilter({
    useDefaults: false,
    allowlist: { extensions: ['png'] },
  });
  const sourceBinaryStat = parseGitNumstat(numstat, { sourceOnly: true, sourceFilter: pngFilter });
  assert.deepEqual(stat, { files: 6, additions: 49, deletions: 7 });
  assert.deepEqual(sourceStat, { files: 4, additions: 29, deletions: 6 });
  assert.deepEqual(sourceBinaryStat, { files: 1, additions: 0, deletions: 0 });
});

test('isFamilyDiffProvenance rejects contradictory availability provenance', () => {
  assert.equal(
    isFamilyDiffProvenance({
      source: 'artifact',
      available: true,
      files: 1,
      additions: 1,
      deletions: 0,
      kind: 'contribution',
      missingReason: 'no-source-diff',
    }),
    false,
  );
  assert.equal(
    isFamilyDiffProvenance({
      source: 'unavailable',
      available: true,
      files: 1,
      additions: 1,
      deletions: 0,
      kind: 'review-input',
    }),
    false,
  );
});

test('captureReviewInputArtifactsForRun writes PR input metadata, diff, and stat artifacts', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'review-input-artifacts-'));
  const run = makeRun({
    flowType: 'pr-complete',
    ticketOrPr: 'owner/repo#123',
    prNumber: 123,
    taskFile: path.join(dir, 'TASK.md'),
  });

  const artifacts = await captureReviewInputArtifactsForRun(run, {
    fetchGitHubPR: async () => ({
      branch: 'fix/family-ledger',
      title: 'PR title',
      body: '',
      baseRef: 'main',
      baseSha: 'base-sha',
      headSha: 'head-sha',
      number: 123,
    }),
    fetchPRDiffFiles: async () => [
      { filename: 'src/a.ts', status: 'modified', additions: 10, deletions: 2, patch: '@@ patch' },
      { filename: 'assets/logo.png', status: 'modified', additions: 0, deletions: 0 },
    ],
  });

  assert.deepEqual(
    artifacts.map((artifact) => artifact.path),
    ['inputs/commit.json', 'inputs/diff.txt', 'inputs/diff-stat.json'],
  );
  const commit = JSON.parse(await readFile(path.join(dir, 'inputs/commit.json'), 'utf-8'));
  assert.equal(commit.repository, 'owner/repo');
  assert.equal(commit.headSha, 'head-sha');
  const diff = await readFile(path.join(dir, 'inputs/diff.txt'), 'utf-8');
  assert.match(diff, /diff --git a\/src\/a\.ts b\/src\/a\.ts/);
  assert.doesNotMatch(diff, /assets\/logo\.png/);
  const diffStat = JSON.parse(await readFile(path.join(dir, 'inputs/diff-stat.json'), 'utf-8'));
  assert.equal(diffStat.available, true);
  assert.equal(diffStat.filter, 'source-code');
  assert.equal(diffStat.files, 1);
  assert.equal(diffStat.additions, 10);
  assert.equal(diffStat.deletions, 2);
  assert.equal(diffStat.baseRef, 'main');
  assert.equal(diffStat.baseSha, 'base-sha');
  assert.equal(diffStat.headRef, 'fix/family-ledger');
  assert.equal(diffStat.headSha, 'head-sha');
});

test('captureReviewInputArtifactsForRun prefers stored PR number over issue ref', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'review-input-artifacts-stored-pr-'));
  const seen: string[] = [];
  const run = makeRun({
    flowType: 'review-pr',
    ticketOrPr: 'owner/repo#123',
    prNumber: 456,
    taskFile: path.join(dir, 'TASK.md'),
  });

  await captureReviewInputArtifactsForRun(run, {
    fetchGitHubPR: async (ref) => {
      seen.push(ref);
      return {
        branch: 'fix/stored-pr',
        title: 'PR title',
        body: '',
        baseRef: 'main',
        baseSha: 'base-sha',
        headSha: 'head-sha',
        number: 456,
      };
    },
    fetchPRDiffFiles: async (repo, prNumber) => {
      seen.push(`${repo}#${prNumber}`);
      return [
        { filename: 'src/a.ts', status: 'modified', additions: 1, deletions: 0, patch: '@@ patch' },
      ];
    },
  });

  assert.deepEqual(seen, ['owner/repo#456', 'owner/repo#456']);
  const commit = JSON.parse(await readFile(path.join(dir, 'inputs/commit.json'), 'utf-8'));
  assert.equal(commit.repository, 'owner/repo');
  assert.equal(commit.prNumber, 456);
  const diffStat = JSON.parse(await readFile(path.join(dir, 'inputs/diff-stat.json'), 'utf-8'));
  assert.equal(diffStat.prNumber, 456);
});

test('captureReviewInputArtifactsForRun omits diff text artifact for binary-only PR input', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'review-input-artifacts-binary-only-'));
  const run = makeRun({
    flowType: 'review-pr',
    ticketOrPr: 'owner/repo#123',
    prNumber: 123,
    taskFile: path.join(dir, 'TASK.md'),
  });

  const artifacts = await captureReviewInputArtifactsForRun(run, {
    fetchGitHubPR: async () => ({
      branch: 'assets-only',
      title: 'Assets only',
      body: '',
      baseRef: 'main',
      baseSha: 'base-sha',
      headSha: 'head-sha',
      number: 123,
    }),
    fetchPRDiffFiles: async () => [
      { filename: 'assets/logo.png', status: 'modified', additions: 0, deletions: 0 },
    ],
  });

  assert.deepEqual(artifacts, [
    { path: 'inputs/commit.json', purpose: 'input-commit' },
    { path: 'inputs/diff-stat.json', purpose: 'input-diff-stat' },
  ]);
  const diffStat = JSON.parse(await readFile(path.join(dir, 'inputs/diff-stat.json'), 'utf-8'));
  assert.equal(diffStat.available, false);
  assert.equal(diffStat.missingReason, 'no-source-diff');
  assert.equal('artifactPath' in diffStat, false);
  await assert.rejects(stat(path.join(dir, 'inputs/diff.txt')));
});

test('captureReviewInputArtifactsForRun writes explicit unavailable commit metadata on GitHub failure', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'review-input-artifacts-fail-'));
  const run = makeRun({
    flowType: 'review-pr',
    ticketOrPr: 'owner/repo#123',
    prNumber: 123,
    taskFile: path.join(dir, 'TASK.md'),
  });

  const artifacts = await captureReviewInputArtifactsForRun(run, {
    fetchGitHubPR: async () => {
      throw new Error('api unavailable');
    },
    fetchPRDiffFiles: async () => [],
  });

  assert.deepEqual(artifacts, [
    { path: 'inputs/commit.json', purpose: 'input-commit' },
    { path: 'inputs/diff-stat.json', purpose: 'input-diff-stat' },
  ]);
  const commit = JSON.parse(await readFile(path.join(dir, 'inputs/commit.json'), 'utf-8'));
  assert.equal(commit.source, 'unavailable');
  assert.equal(commit.missingReason, 'github-pr-input-unavailable');
  const diffStat = JSON.parse(await readFile(path.join(dir, 'inputs/diff-stat.json'), 'utf-8'));
  assert.equal(diffStat.source, 'unavailable');
  assert.equal(diffStat.available, false);
  assert.equal(diffStat.kind, 'review-input');
  assert.equal(diffStat.missingReason, 'github-pr-input-unavailable');
  assert.equal(diffStat.prNumber, 123);
  await assert.rejects(stat(path.join(dir, 'inputs/diff.txt')));
});

test('captureReviewInputArtifactsForRun preserves PR metadata when diff file fetch fails', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'review-input-artifacts-partial-pr-'));
  const run = makeRun({
    flowType: 'review-pr',
    ticketOrPr: 'owner/repo#123',
    prNumber: 123,
    taskFile: path.join(dir, 'TASK.md'),
  });

  await captureReviewInputArtifactsForRun(run, {
    fetchGitHubPR: async () => ({
      branch: 'fix/partial',
      title: 'Partial receipt',
      body: '',
      baseRef: 'main',
      baseSha: 'base-sha',
      headSha: 'head-sha',
      number: 123,
    }),
    fetchPRDiffFiles: async () => {
      throw new Error('files unavailable');
    },
  });

  const commit = JSON.parse(await readFile(path.join(dir, 'inputs/commit.json'), 'utf-8'));
  assert.equal(commit.source, 'unavailable');
  assert.equal(commit.missingReason, 'github-pr-input-partial');
  assert.equal(commit.baseRef, 'main');
  assert.equal(commit.headRef, 'fix/partial');
  assert.equal(commit.headSha, 'head-sha');
  assert.equal(commit.error, 'files unavailable');
  const diffStat = JSON.parse(await readFile(path.join(dir, 'inputs/diff-stat.json'), 'utf-8'));
  assert.equal(diffStat.source, 'unavailable');
  assert.equal(diffStat.baseRef, 'main');
  assert.equal(diffStat.baseSha, 'base-sha');
  assert.equal(diffStat.headRef, 'fix/partial');
  assert.equal(diffStat.headSha, 'head-sha');
  assert.equal(diffStat.missingReason, 'github-pr-input-partial');
});

test('captureReviewInputArtifactsForRun does not overwrite available input diff with a later unavailable retry', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'review-input-artifacts-preserve-available-'));
  const inputsDir = path.join(dir, 'inputs');
  await mkdir(inputsDir, { recursive: true });
  await writeFile(
    path.join(inputsDir, 'commit.json'),
    JSON.stringify({
      repository: 'owner/repo',
      prNumber: 123,
      capturedAt: '2026-05-03T00:00:00.000Z',
      source: 'github-pr',
    }),
    'utf-8',
  );
  await writeFile(path.join(inputsDir, 'diff.txt'), 'diff --git a/src/a.ts b/src/a.ts', 'utf-8');
  await writeFile(
    path.join(inputsDir, 'diff-stat.json'),
    JSON.stringify({
      source: 'artifact',
      available: true,
      files: 1,
      additions: 1,
      deletions: 0,
      kind: 'review-input',
      artifactPath: 'inputs/diff.txt',
      capturedAt: '2026-05-03T00:00:00.000Z',
    }),
    'utf-8',
  );

  const artifacts = await captureReviewInputArtifactsForRun(
    makeRun({
      flowType: 'review-pr',
      ticketOrPr: 'owner/repo#123',
      taskFile: path.join(dir, 'TASK.md'),
    }),
    {
      fetchGitHubPR: async () => {
        throw new Error('temporary gh outage');
      },
      fetchPRDiffFiles: async () => [],
    },
  );

  assert.deepEqual(
    artifacts.map((artifact) => artifact.path),
    ['inputs/commit.json', 'inputs/diff.txt', 'inputs/diff-stat.json'],
  );
  const diffStat = JSON.parse(await readFile(path.join(inputsDir, 'diff-stat.json'), 'utf-8'));
  assert.equal(diffStat.available, true);
  assert.equal(diffStat.files, 1);
  assert.equal(
    await readFile(path.join(inputsDir, 'diff.txt'), 'utf-8'),
    'diff --git a/src/a.ts b/src/a.ts',
  );
});

test('captureReviewInputArtifactsForRun reuses fresh review input receipt without GitHub round trip', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'review-input-artifacts-fresh-reuse-'));
  const inputsDir = path.join(dir, 'inputs');
  await mkdir(inputsDir, { recursive: true });
  await writeFile(
    path.join(inputsDir, 'commit.json'),
    JSON.stringify({
      repository: 'owner/repo',
      prNumber: 123,
      capturedAt: new Date().toISOString(),
      source: 'github-pr',
    }),
    'utf-8',
  );
  await writeFile(path.join(inputsDir, 'diff.txt'), 'diff --git a/src/a.ts b/src/a.ts', 'utf-8');
  await writeFile(
    path.join(inputsDir, 'diff-stat.json'),
    JSON.stringify({
      source: 'artifact',
      available: true,
      files: 1,
      additions: 1,
      deletions: 0,
      kind: 'review-input',
      repository: 'owner/repo',
      prNumber: 123,
      artifactPath: 'inputs/diff.txt',
      capturedAt: new Date().toISOString(),
    }),
    'utf-8',
  );
  let calls = 0;

  const artifacts = await captureReviewInputArtifactsForRun(
    makeRun({
      flowType: 'review-pr',
      ticketOrPr: 'owner/repo#123',
      prNumber: 123,
      taskFile: path.join(dir, 'TASK.md'),
    }),
    {
      fetchGitHubPR: async () => {
        calls += 1;
        throw new Error('fresh receipt should skip GitHub');
      },
      fetchPRDiffFiles: async () => {
        calls += 1;
        return [];
      },
    },
  );

  assert.equal(calls, 0);
  assert.deepEqual(
    artifacts.map((artifact) => artifact.path),
    ['inputs/commit.json', 'inputs/diff.txt', 'inputs/diff-stat.json'],
  );
});

test('captureReviewInputArtifactsForRun serializes concurrent writes so slow failures cannot clobber success', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'review-input-artifacts-concurrent-'));
  const run = makeRun({
    flowType: 'review-pr',
    ticketOrPr: 'owner/repo#123',
    prNumber: 123,
    taskFile: path.join(dir, 'TASK.md'),
  });
  const pr = {
    branch: 'fix/concurrent',
    title: 'Concurrent receipt',
    body: '',
    baseRef: 'main',
    baseSha: 'base-sha',
    headSha: 'head-sha',
    number: 123,
  };

  await Promise.all([
    captureReviewInputArtifactsForRun(run, {
      fetchGitHubPR: async () => pr,
      fetchPRDiffFiles: async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        throw new Error('slow files failure');
      },
    }),
    captureReviewInputArtifactsForRun(run, {
      fetchGitHubPR: async () => pr,
      fetchPRDiffFiles: async () => [
        { filename: 'src/a.ts', status: 'modified', additions: 2, deletions: 1, patch: '@@ patch' },
      ],
    }),
  ]);

  const diffStat = JSON.parse(await readFile(path.join(dir, 'inputs/diff-stat.json'), 'utf-8'));
  assert.equal(diffStat.available, true);
  assert.equal(diffStat.files, 1);
  assert.match(await readFile(path.join(dir, 'inputs/diff.txt'), 'utf-8'), /src\/a\.ts/);
});

test('captureReviewInputArtifactsForRun treats PR number 0 as an invalid sentinel', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'review-input-artifacts-invalid-zero-'));
  const artifacts = await captureReviewInputArtifactsForRun(
    makeRun({
      flowType: 'review-pr',
      ticketOrPr: 'owner/repo#0',
      taskFile: path.join(dir, 'TASK.md'),
      prNumber: 0,
    }),
  );

  assert.deepEqual(artifacts, [
    { path: 'inputs/commit.json', purpose: 'input-commit' },
    { path: 'inputs/diff-stat.json', purpose: 'input-diff-stat' },
  ]);
  const diffStat = JSON.parse(await readFile(path.join(dir, 'inputs/diff-stat.json'), 'utf-8'));
  assert.equal(diffStat.missingReason, 'missing-pr-ref');
  assert.equal('prNumber' in diffStat, false);
});

test('captureReviewInputArtifactsForRun writes unavailable diff provenance when PR ref is missing', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'review-input-artifacts-missing-ref-'));
  const artifacts = await captureReviewInputArtifactsForRun(
    makeRun({
      flowType: 'review-pr',
      ticketOrPr: 'PROJ-123',
      taskFile: path.join(dir, 'TASK.md'),
      prNumber: undefined,
    }),
  );

  assert.deepEqual(artifacts, [
    { path: 'inputs/commit.json', purpose: 'input-commit' },
    { path: 'inputs/diff-stat.json', purpose: 'input-diff-stat' },
  ]);
  const diffStat = JSON.parse(await readFile(path.join(dir, 'inputs/diff-stat.json'), 'utf-8'));
  assert.equal(diffStat.source, 'unavailable');
  assert.equal(diffStat.available, false);
  assert.equal(diffStat.missingReason, 'missing-pr-ref');
});

test('captureRunDiffArtifacts preserves an existing durable diff snapshot', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'run-diff-artifacts-existing-'));
  const artifactsDir = path.join(dir, 'artifacts');
  await mkdir(artifactsDir, { recursive: true });
  const existing = {
    source: 'artifact',
    available: true,
    files: 1,
    additions: 2,
    deletions: 3,
    kind: 'contribution',
    filter: 'source-code',
    artifactPath: 'artifacts/diff.txt',
    capturedAt: '2026-05-03T00:00:00.000Z',
  };
  await writeFile(path.join(artifactsDir, 'diff.txt'), 'original diff', 'utf-8');
  await writeFile(path.join(artifactsDir, 'diff-stat.json'), JSON.stringify(existing), 'utf-8');

  const result = await captureRunDiffArtifacts(
    makeRun({
      slotId: 'missing-slot-for-overwrite-test',
      taskFile: path.join(dir, 'TASK.md'),
    }),
  );

  assert.equal(result.files, 1);
  assert.equal(result.additions, 2);
  assert.equal(await readFile(path.join(artifactsDir, 'diff.txt'), 'utf-8'), 'original diff');
});

test('publication refresh preserves a durable diff when its slot was removed', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'run-diff-artifacts-force-refresh-'));
  const artifactsDir = path.join(dir, 'artifacts');
  await mkdir(artifactsDir, { recursive: true });
  await writeFile(path.join(artifactsDir, 'diff.txt'), 'stale diff', 'utf-8');
  await writeFile(
    path.join(artifactsDir, 'diff-stat.json'),
    JSON.stringify({
      source: 'artifact',
      available: true,
      files: 1,
      additions: 2,
      deletions: 3,
      kind: 'contribution',
      filter: 'source-code',
      artifactPath: 'artifacts/diff.txt',
      capturedAt: '2026-05-03T00:00:00.000Z',
    }),
    'utf-8',
  );

  const result = await captureRunDiffArtifacts(
    makeRun({
      slotId: 'missing-slot-for-force-refresh-test',
      taskFile: path.join(dir, 'TASK.md'),
    }),
    { forceRecapture: true },
  );

  assert.equal(result.source, 'artifact');
  assert.equal(result.files, 1);
  assert.equal(result.additions, 2);
  assert.equal(result.deletions, 3);
  const persisted = JSON.parse(await readFile(path.join(artifactsDir, 'diff-stat.json'), 'utf-8'));
  assert.equal(persisted.source, 'artifact');
  assert.equal(persisted.files, 1);
  assert.equal(
    (await readdir(artifactsDir)).some((name) => name.startsWith('diff.txt.previous.')),
    false,
  );
  assert.equal(await readFile(path.join(artifactsDir, 'diff.txt'), 'utf-8'), 'stale diff');
});

test('captureRunDiffArtifacts captures iteration diff when contribution diff is reused', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'run-diff-artifacts-iteration-reuse-'));
  const artifactsDir = path.join(dir, 'artifacts');
  await mkdir(artifactsDir, { recursive: true });
  const existing = {
    source: 'artifact',
    available: true,
    files: 1,
    additions: 2,
    deletions: 3,
    kind: 'contribution',
    filter: 'source-code',
    artifactPath: 'artifacts/diff.txt',
    capturedAt: '2026-05-03T00:00:00.000Z',
  };
  await writeFile(path.join(artifactsDir, 'diff.txt'), 'original diff', 'utf-8');
  await writeFile(path.join(artifactsDir, 'diff-stat.json'), JSON.stringify(existing), 'utf-8');

  const result = await captureRunDiffArtifacts(
    makeRun({
      slotId: 'missing-slot-for-iteration-reuse-test',
      taskFile: path.join(dir, 'TASK.md'),
      worktreeHeadAtDispatch: 'abc123deadbeef',
    }),
  );

  assert.equal(result.files, 1);
  assert.equal(await readFile(path.join(artifactsDir, 'diff.txt'), 'utf-8'), 'original diff');
  const iterationStat = JSON.parse(
    await readFile(path.join(artifactsDir, 'iteration-diff-stat.json'), 'utf-8'),
  );
  assert.equal(iterationStat.kind, 'iteration');
  assert.equal(iterationStat.available, false);
  assert.equal(iterationStat.missingReason, 'slot-vars-unavailable');
});

test('captureRunDiffArtifacts preserves stale diff text as previous when recapture is unavailable', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'run-diff-artifacts-stale-'));
  const artifactsDir = path.join(dir, 'artifacts');
  await mkdir(artifactsDir, { recursive: true });
  await writeFile(path.join(artifactsDir, 'diff.txt'), 'stale worker diff', 'utf-8');
  await writeFile(
    path.join(artifactsDir, 'diff-stat.json'),
    JSON.stringify({
      source: 'unavailable',
      available: false,
      files: 0,
      additions: 0,
      deletions: 0,
      kind: 'contribution',
      missingReason: 'old-unavailable',
    }),
    'utf-8',
  );

  const result = await captureRunDiffArtifacts(
    makeRun({
      slotId: 'missing-slot-for-recapture-test',
      taskFile: path.join(dir, 'TASK.md'),
    }),
  );

  assert.equal(result.available, false);
  assert.equal(result.files, 0);
  await assert.rejects(stat(path.join(artifactsDir, 'diff.txt')));
  const previousName = (await readdir(artifactsDir)).find((name) =>
    name.startsWith('diff.txt.previous.'),
  );
  assert(previousName);
  assert.equal(await readFile(path.join(artifactsDir, previousName), 'utf-8'), 'stale worker diff');
});

test('captureRunDiffArtifacts serializes concurrent unavailable recaptures without racing previous diff preservation', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'run-diff-artifacts-concurrent-unavailable-'));
  const artifactsDir = path.join(dir, 'artifacts');
  await mkdir(artifactsDir, { recursive: true });
  await writeFile(path.join(artifactsDir, 'diff.txt'), 'stale worker diff', 'utf-8');
  await writeFile(
    path.join(artifactsDir, 'diff-stat.json'),
    JSON.stringify({
      source: 'unavailable',
      available: false,
      files: 0,
      additions: 0,
      deletions: 0,
      kind: 'contribution',
      missingReason: 'old-unavailable',
    }),
    'utf-8',
  );
  const run = makeRun({
    id: 'concurrent-run-diff-artifacts',
    slotId: null,
    taskFile: path.join(dir, 'TASK.md'),
  });

  const [first, second] = await Promise.all([
    captureRunDiffArtifacts(run),
    captureRunDiffArtifacts(run),
  ]);

  assert.equal(first.available, false);
  assert.equal(second.available, false);
  await assert.rejects(stat(path.join(artifactsDir, 'diff.txt')));
  const previousNames = (await readdir(artifactsDir)).filter((name) =>
    name.startsWith('diff.txt.previous.'),
  );
  assert.equal(previousNames.length, 1);
  assert.equal(
    await readFile(path.join(artifactsDir, previousNames[0]), 'utf-8'),
    'stale worker diff',
  );
});

test('captureRunDiffArtifacts reuses recent deterministic unavailable provenance to avoid retry thrash', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'run-diff-artifacts-recent-unavailable-'));
  const artifactsDir = path.join(dir, 'artifacts');
  await mkdir(artifactsDir, { recursive: true });
  const recent = {
    source: 'unavailable',
    available: false,
    files: 0,
    additions: 0,
    deletions: 0,
    partialStat: { files: 2, additions: 11, deletions: 3 },
    kind: 'contribution',
    missingReason: 'diff-artifact-too-large',
    capturedAt: new Date().toISOString(),
  };
  await writeFile(path.join(artifactsDir, 'diff-stat.json'), JSON.stringify(recent), 'utf-8');

  const result = await captureRunDiffArtifacts(
    makeRun({
      slotId: 'missing-slot-that-would-fail-if-retried',
      taskFile: path.join(dir, 'TASK.md'),
    }),
  );

  assert.equal(result.missingReason, 'diff-artifact-too-large');
  assert.equal(result.capturedAt, recent.capturedAt);
  assert.deepEqual(result.partialStat, { files: 2, additions: 11, deletions: 3 });
});

test('captureRunDiffArtifacts does not reuse recent transient unavailable provenance', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'run-diff-artifacts-transient-unavailable-'));
  const artifactsDir = path.join(dir, 'artifacts');
  await mkdir(artifactsDir, { recursive: true });
  await writeFile(
    path.join(artifactsDir, 'diff-stat.json'),
    JSON.stringify({
      source: 'unavailable',
      available: false,
      files: 0,
      additions: 0,
      deletions: 0,
      kind: 'contribution',
      missingReason: 'head-ref-unavailable',
      capturedAt: new Date().toISOString(),
    }),
    'utf-8',
  );

  const result = await captureRunDiffArtifacts(
    makeRun({
      slotId: null,
      taskFile: path.join(dir, 'TASK.md'),
    }),
  );

  assert.equal(result.missingReason, 'missing-slot');
});

test('captureRunDiffArtifacts honors deterministic unavailable cooldown across kind mismatch', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'run-diff-artifacts-kind-mismatch-'));
  const artifactsDir = path.join(dir, 'artifacts');
  await mkdir(artifactsDir, { recursive: true });
  await writeFile(
    path.join(artifactsDir, 'diff-stat.json'),
    JSON.stringify({
      source: 'unavailable',
      available: false,
      files: 0,
      additions: 0,
      deletions: 0,
      partialStat: { files: 2, additions: 11, deletions: 3 },
      kind: 'contribution',
      missingReason: 'diff-artifact-too-large',
      capturedAt: new Date().toISOString(),
    }),
    'utf-8',
  );

  const result = await captureRunDiffArtifacts(
    makeRun({
      flowType: 'review-pr',
      slotId: null,
      taskFile: path.join(dir, 'TASK.md'),
    }),
  );

  assert.equal(result.kind, 'review-input');
  assert.equal(result.missingReason, 'diff-kind-mismatch-cooldown');
  assert.deepEqual(result.partialStat, { files: 2, additions: 11, deletions: 3 });
});

test('captureRunDiffArtifacts does not honor cooldown when capturedAt is in the future (clock skew)', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'run-diff-artifacts-clock-skew-'));
  const artifactsDir = path.join(dir, 'artifacts');
  await mkdir(artifactsDir, { recursive: true });
  // capturedAt one hour ahead of "now" simulates an NTP backwards step or a
  // host clock that was set forward then corrected; the prior cooldown check
  // computed `nowMs - capturedAtMs` and treated negative deltas as "still
  // cooling down", which would have reused the stale unavailable artifact
  // forever.
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  await writeFile(
    path.join(artifactsDir, 'diff-stat.json'),
    JSON.stringify({
      source: 'unavailable',
      available: false,
      files: 0,
      additions: 0,
      deletions: 0,
      kind: 'contribution',
      missingReason: 'diff-artifact-too-large',
      capturedAt: future,
    }),
    'utf-8',
  );

  const result = await captureRunDiffArtifacts(
    makeRun({
      slotId: null,
      taskFile: path.join(dir, 'TASK.md'),
    }),
  );

  assert.equal(result.missingReason, 'missing-slot');
  assert.notEqual(result.capturedAt, future);
});

test('captureRunDiffArtifacts and captureReviewInputArtifactsForRun share a per-run mutex without corrupting outputs', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'run-mutex-cross-capture-'));
  const artifactsDir = path.join(dir, 'artifacts');
  await mkdir(artifactsDir, { recursive: true });
  await writeFile(path.join(artifactsDir, 'diff.txt'), 'stale worker diff', 'utf-8');
  await writeFile(
    path.join(artifactsDir, 'diff-stat.json'),
    JSON.stringify({
      source: 'unavailable',
      available: false,
      files: 0,
      additions: 0,
      deletions: 0,
      kind: 'contribution',
      missingReason: 'old-unavailable',
    }),
    'utf-8',
  );
  const run = makeRun({
    id: 'mutex-cross-run',
    flowType: 'pr-complete',
    ticketOrPr: 'owner/repo#321',
    slotId: null,
    taskFile: path.join(dir, 'TASK.md'),
  });

  const [contribution, reviewArtifacts] = await Promise.all([
    captureRunDiffArtifacts(run),
    captureReviewInputArtifactsForRun(run, {
      fetchGitHubPR: async () => ({
        branch: 'feat/x',
        title: 't',
        body: 'b',
        baseRef: 'main',
        baseSha: 'b1',
        headSha: 'h1',
        number: 321,
      }),
      fetchPRDiffFiles: async () => [
        { filename: 'src/x.ts', status: 'modified', additions: 5, deletions: 2, patch: '@@' },
      ],
    }),
  ]);

  assert.equal(contribution.kind, 'contribution');
  assert.equal(contribution.available, false);
  const inputDiffStat = JSON.parse(
    await readFile(path.join(dir, 'inputs', 'diff-stat.json'), 'utf-8'),
  );
  assert.equal(inputDiffStat.kind, 'review-input');
  assert.equal(inputDiffStat.available, true);
  assert.equal(inputDiffStat.files, 1);
  // Both captures share the run-id mutex; .tmp atomic-write scratch files must
  // not survive either capture path.
  const inputsListing = await readdir(path.join(dir, 'inputs'));
  assert.equal(
    inputsListing.some((name) => name.includes('.tmp.')),
    false,
  );
  const artifactsListing = await readdir(artifactsDir);
  assert.equal(
    artifactsListing.some((name) => name.includes('.tmp.')),
    false,
  );
  assert(reviewArtifacts.some((entry) => entry.path === 'inputs/diff.txt'));
});

test('resolveReviewInputCaptureTimeoutMs falls back to 8000 when project does not override it', () => {
  assert.equal(resolveReviewInputCaptureTimeoutMs(null), 8_000);
  assert.equal(resolveReviewInputCaptureTimeoutMs({}), 8_000);
  assert.equal(resolveReviewInputCaptureTimeoutMs({ diff_analysis: {} }), 8_000);
});

test('resolveReviewInputCaptureTimeoutMs honors project diff_analysis.review_input_timeout_ms', () => {
  assert.equal(
    resolveReviewInputCaptureTimeoutMs({ diff_analysis: { review_input_timeout_ms: 15_000 } }),
    15_000,
  );
});

test('resolveReviewInputCaptureTimeoutMs clamps overrides outside [1000, 60000]', () => {
  assert.equal(
    resolveReviewInputCaptureTimeoutMs({ diff_analysis: { review_input_timeout_ms: 50 } }),
    1_000,
  );
  assert.equal(
    resolveReviewInputCaptureTimeoutMs({ diff_analysis: { review_input_timeout_ms: 600_000 } }),
    60_000,
  );
});

test('resolveReviewInputCaptureTimeoutMs ignores non-numeric overrides', () => {
  assert.equal(
    resolveReviewInputCaptureTimeoutMs({
      diff_analysis: { review_input_timeout_ms: 'fast' as unknown as number },
    }),
    8_000,
  );
  assert.equal(
    resolveReviewInputCaptureTimeoutMs({ diff_analysis: { review_input_timeout_ms: Number.NaN } }),
    8_000,
  );
});
