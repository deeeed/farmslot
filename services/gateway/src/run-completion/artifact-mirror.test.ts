// @farmslot:serial — creates and removes real JSON under the shared repo `pool/`.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { farmslotRoot } from '../fleet/state.js';

import {
  pruneRecipeRunHistory,
  refreshArtifactMirror,
  shouldClearLocalRecipeRunCache,
} from './artifact-mirror.js';
import { makeRun } from './test-fixtures.js';

test('refreshArtifactMirror preserves gateway-owned review artifacts while clearing stale worker files', async (t) => {
  const testId = `mirror-gateway-owned-${process.pid}-${Date.now()}`;
  const poolFile = path.join(farmslotRoot, 'pool', `${testId}.json`);
  const workerRepo = await mkdtemp(path.join(tmpdir(), `${testId}-worker-`));
  const taskRoot = path.join(farmslotRoot, '.sandbox/farmslot-farm/tasks');
  const taskRelDir = `test/${testId}`;
  const taskDir = path.join(taskRoot, taskRelDir);
  const taskFile = path.join(taskDir, 'TASK.md');
  const workerTaskDir = path.join(workerRepo, '.sandbox/farmslot-farm/worker-task', taskRelDir);
  const slotId = `${testId}-slot`;
  t.after(async () => {
    await rm(taskDir, { recursive: true, force: true });
    await rm(workerRepo, { recursive: true, force: true });
    await rm(poolFile, { force: true });
  });

  await mkdir(path.join(workerTaskDir, 'artifacts'), { recursive: true });
  await mkdir(path.join(taskDir, 'artifacts'), { recursive: true });
  await writeFile(taskFile, '# mirror test\n');
  await writeFile(path.join(workerTaskDir, 'TASK.md'), '# mirror test\n');
  await writeFile(path.join(workerTaskDir, 'artifacts/report.md'), 'worker report\n');
  await writeFile(path.join(workerTaskDir, 'artifacts/after.png'), 'fresh worker image\n');
  await writeFile(path.join(workerTaskDir, 'artifacts/pr-package.json'), '{"worker":true}\n');
  await mkdir(path.join(workerTaskDir, 'artifacts/review-loop-1'), { recursive: true });
  await writeFile(path.join(workerTaskDir, 'artifacts/review-loop-1/review.diff'), 'worker diff\n');
  await writeFile(
    path.join(workerTaskDir, 'artifacts/latest-valid-recipe-run.json'),
    '{"version":1,"runId":"bad","relativeArtifactRoot":"../outside"}\n',
  );
  await mkdir(path.join(taskDir, 'artifacts/recipe-runs/cached-run'), { recursive: true });
  await writeFile(
    path.join(taskDir, 'artifacts/recipe-runs/cached-run/summary.json'),
    '{"status":"pass"}\n',
  );
  await mkdir(path.join(taskDir, 'artifacts/review-loop-1'), { recursive: true });
  await writeFile(path.join(taskDir, 'artifacts/review-loop-1/review.diff'), 'self diff\n');
  await writeFile(path.join(taskDir, 'artifacts/pr-package.json'), '{"gateway":true}\n');
  await mkdir(path.join(taskDir, 'artifacts/independent-review-2/review-loop-1'), {
    recursive: true,
  });
  await writeFile(path.join(taskDir, 'artifacts/independent-review-2.json'), '{}\n');
  await writeFile(path.join(taskDir, 'artifacts/independent-review-2.md'), '# Review\n');
  await writeFile(
    path.join(taskDir, 'artifacts/independent-review-2/review-loop-1/review.diff'),
    'diff\n',
  );
  await writeFile(path.join(taskDir, 'artifacts/publication-gate-hold-abc.md'), '# Hold\n');
  await writeFile(path.join(taskDir, 'artifacts/stale-worker-owned.png'), 'stale\n');
  await writeFile(
    poolFile,
    JSON.stringify(
      {
        machine: 'localhost',
        project: 'farmslot-farm',
        platform: 'cli',
        os: 'darwin',
        host: 'localhost',
        ssh_user: userInfo().username,
        slots: [{ id: slotId, enabled: true, repo: workerRepo, session: slotId }],
      },
      null,
      2,
    ),
  );

  const copied = await refreshArtifactMirror(
    makeRun({ id: testId, project: 'farmslot-farm', slotId, taskFile }),
  );

  assert.equal(copied >= 2, true);
  assert.equal(existsSync(path.join(taskDir, 'artifacts/after.png')), true);
  assert.equal(existsSync(path.join(taskDir, 'artifacts/independent-review-2.json')), true);
  assert.equal(existsSync(path.join(taskDir, 'artifacts/independent-review-2.md')), true);
  assert.equal(
    existsSync(path.join(taskDir, 'artifacts/recipe-runs/cached-run/summary.json')),
    true,
  );
  assert.equal(
    await readFile(path.join(taskDir, 'artifacts/review-loop-1/review.diff'), 'utf-8'),
    'self diff\n',
  );
  assert.equal(
    await readFile(path.join(taskDir, 'artifacts/pr-package.json'), 'utf-8'),
    '{"gateway":true}\n',
  );
  assert.equal(
    existsSync(path.join(taskDir, 'artifacts/independent-review-2/review-loop-1/review.diff')),
    true,
  );
  assert.equal(existsSync(path.join(taskDir, 'artifacts/publication-gate-hold-abc.md')), true);
  assert.equal(existsSync(path.join(taskDir, 'artifacts/stale-worker-owned.png')), false);
});

// Local-branch integrity for refreshArtifactMirror (fs.copyFile). Remote multi-chunk
// progress + byte equality is proven by diagnostics.fileTransfer.remoteE2e.artifactMirror
// against a connected node (see methods/file-transfer.ts).
test('refreshArtifactMirror copies a large multi-chunk fixture with local byte equality', async (t) => {
  const { createHash } = await import('node:crypto');
  const { FILE_TRANSFER_CHUNK_MAX_BYTES } = await import('@farmslot/protocol');
  const testId = `mirror-large-${process.pid}-${Date.now()}`;
  const poolFile = path.join(farmslotRoot, 'pool', `${testId}.json`);
  const workerRepo = await mkdtemp(path.join(tmpdir(), `${testId}-worker-`));
  const taskRoot = path.join(farmslotRoot, '.sandbox/farmslot-farm/tasks');
  const taskRelDir = `test/${testId}`;
  const taskDir = path.join(taskRoot, taskRelDir);
  const taskFile = path.join(taskDir, 'TASK.md');
  const workerTaskDir = path.join(workerRepo, '.sandbox/farmslot-farm/worker-task', taskRelDir);
  const slotId = `${testId}-slot`;
  t.after(async () => {
    await rm(taskDir, { recursive: true, force: true });
    await rm(workerRepo, { recursive: true, force: true });
    await rm(poolFile, { force: true });
  });

  await mkdir(path.join(workerTaskDir, 'artifacts'), { recursive: true });
  await mkdir(path.join(taskDir, 'artifacts'), { recursive: true });
  await writeFile(taskFile, '# large mirror test\n');
  await writeFile(path.join(workerTaskDir, 'TASK.md'), '# large mirror test\n');
  // Multi-chunk-sized fixture — production refreshArtifactMirror path must preserve bytes.
  // Top-level media is in the publish package at any size.
  const large = Buffer.alloc(FILE_TRANSFER_CHUNK_MAX_BYTES * 3 + 17);
  for (let i = 0; i < large.byteLength; i++) large[i] = i % 251;
  const largePath = path.join(workerTaskDir, 'artifacts/large-mirror.mp4');
  await writeFile(largePath, large);
  const expectedHash = createHash('sha256').update(large).digest('hex');

  await writeFile(
    poolFile,
    JSON.stringify(
      {
        machine: 'localhost',
        project: 'farmslot-farm',
        platform: 'cli',
        os: 'darwin',
        host: 'localhost',
        ssh_user: userInfo().username,
        slots: [{ id: slotId, enabled: true, repo: workerRepo, session: slotId }],
      },
      null,
      2,
    ),
  );

  const copied = await refreshArtifactMirror(
    makeRun({ id: testId, project: 'farmslot-farm', slotId, taskFile }),
  );
  assert.ok(copied >= 1);
  const dest = path.join(taskDir, 'artifacts/large-mirror.mp4');
  assert.equal(existsSync(dest), true);
  const got = await readFile(dest);
  assert.equal(got.byteLength, large.byteLength);
  assert.equal(createHash('sha256').update(got).digest('hex'), expectedHash);
});

test('shouldClearLocalRecipeRunCache only clears when the worker pointer is truly absent', () => {
  assert.equal(shouldClearLocalRecipeRunCache(false, null), true);
  assert.equal(shouldClearLocalRecipeRunCache(true, null), false);
  assert.equal(
    shouldClearLocalRecipeRunCache(true, {
      version: 1,
      runId: 'keep-run',
      relativeArtifactRoot: 'recipe-runs/keep-run',
    }),
    false,
  );
});

test('refreshArtifactMirror rejects evidence-manifest references to internal artifacts', async (t) => {
  const testId = `mirror-internal-manifest-${process.pid}-${Date.now()}`;
  const poolFile = path.join(farmslotRoot, 'pool', `${testId}.json`);
  const workerRepo = await mkdtemp(path.join(tmpdir(), `${testId}-worker-`));
  const taskRoot = path.join(farmslotRoot, '.sandbox/farmslot-farm/tasks');
  const taskRelDir = `test/${testId}`;
  const taskDir = path.join(taskRoot, taskRelDir);
  const taskFile = path.join(taskDir, 'TASK.md');
  const workerTaskDir = path.join(workerRepo, '.sandbox/farmslot-farm/worker-task', taskRelDir);
  const slotId = `${testId}-slot`;
  t.after(async () => {
    await rm(taskDir, { recursive: true, force: true });
    await rm(workerRepo, { recursive: true, force: true });
    await rm(poolFile, { force: true });
  });

  await mkdir(path.join(workerTaskDir, 'artifacts/runtime-relaunch/chrome-profile'), {
    recursive: true,
  });
  await mkdir(path.join(taskDir, 'artifacts'), { recursive: true });
  await writeFile(taskFile, '# mirror test\n');
  await writeFile(path.join(workerTaskDir, 'TASK.md'), '# mirror test\n');
  await writeFile(
    path.join(workerTaskDir, 'artifacts/evidence-manifest.json'),
    JSON.stringify({
      version: 1,
      standalone: [{ label: 'Internal', file: 'runtime-relaunch/chrome-profile/cache.png' }],
    }),
  );
  await writeFile(
    path.join(workerTaskDir, 'artifacts/runtime-relaunch/chrome-profile/cache.png'),
    'png',
  );
  await writeFile(
    poolFile,
    JSON.stringify(
      {
        machine: 'localhost',
        project: 'farmslot-farm',
        platform: 'cli',
        os: 'darwin',
        host: 'localhost',
        ssh_user: userInfo().username,
        slots: [{ id: slotId, enabled: true, repo: workerRepo, session: slotId }],
      },
      null,
      2,
    ),
  );

  await assert.rejects(
    () =>
      refreshArtifactMirror(makeRun({ id: testId, project: 'farmslot-farm', slotId, taskFile })),
    /evidence-manifest references internal artifact: artifacts\/runtime-relaunch\/chrome-profile\/cache\.png/,
  );
  assert.equal(
    existsSync(path.join(taskDir, 'artifacts/runtime-relaunch/chrome-profile/cache.png')),
    false,
  );
});

test('pruneRecipeRunHistory skips symlinked recipe run entries', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'farmslot-run-completion-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const artifactsDir = path.join(root, 'artifacts');
  const recipeRunsDir = path.join(artifactsDir, 'recipe-runs');
  const keepRunDir = path.join(recipeRunsDir, 'keep-run');
  const oldRunDir = path.join(recipeRunsDir, 'old-run');
  const externalDir = path.join(root, 'outside-run');
  await mkdir(keepRunDir, { recursive: true });
  await mkdir(oldRunDir, { recursive: true });
  await mkdir(externalDir, { recursive: true });
  await writeFile(path.join(oldRunDir, 'summary.json'), '{"status":"fail"}', 'utf-8');
  await writeFile(path.join(externalDir, 'sentinel.txt'), 'keep me', 'utf-8');
  await symlink(externalDir, path.join(recipeRunsDir, 'linked-run'));
  await writeFile(
    path.join(artifactsDir, 'latest-valid-recipe-run.json'),
    JSON.stringify({
      version: 1,
      runId: 'keep-run',
      relativeArtifactRoot: 'recipe-runs/keep-run',
    }),
    'utf-8',
  );

  await pruneRecipeRunHistory(artifactsDir);

  assert.equal(existsSync(keepRunDir), true);
  assert.equal(existsSync(oldRunDir), false);
  assert.equal(existsSync(path.join(recipeRunsDir, 'linked-run')), true);
  assert.equal(existsSync(path.join(externalDir, 'sentinel.txt')), true);
});

test('pruneRecipeRunHistory warns when latest-valid recipe-run pointer is invalid', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'farmslot-run-completion-invalid-pointer-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const artifactsDir = path.join(root, 'artifacts');
  await mkdir(artifactsDir, { recursive: true });
  await writeFile(
    path.join(artifactsDir, 'latest-valid-recipe-run.json'),
    JSON.stringify({
      version: 1,
      runId: 'bad-run',
      relativeArtifactRoot: '../outside',
    }),
    'utf-8',
  );

  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (message?: unknown, ...rest: unknown[]) => {
    warnings.push([message, ...rest].map((part) => String(part)).join(' '));
  };
  t.after(() => {
    console.warn = originalWarn;
  });

  await pruneRecipeRunHistory(artifactsDir);

  assert.ok(
    warnings.some((warning) => warning.includes('invalid latest valid recipe-run pointer')),
  );
});

test('pruneRecipeRunHistory keeps cached history when promoted run cache is missing', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'farmslot-run-completion-missing-promoted-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const artifactsDir = path.join(root, 'artifacts');
  const recipeRunsDir = path.join(artifactsDir, 'recipe-runs');
  const oldRunDir = path.join(recipeRunsDir, 'old-run');
  const anotherRunDir = path.join(recipeRunsDir, 'another-run');
  await mkdir(oldRunDir, { recursive: true });
  await mkdir(anotherRunDir, { recursive: true });
  await writeFile(path.join(oldRunDir, 'summary.json'), '{"status":"pass"}', 'utf-8');
  await writeFile(path.join(anotherRunDir, 'summary.json'), '{"status":"fail"}', 'utf-8');
  await writeFile(
    path.join(artifactsDir, 'latest-valid-recipe-run.json'),
    JSON.stringify({
      version: 1,
      runId: 'missing-run',
      relativeArtifactRoot: 'recipe-runs/missing-run',
    }),
    'utf-8',
  );

  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (message?: unknown, ...rest: unknown[]) => {
    warnings.push([message, ...rest].map((part) => String(part)).join(' '));
  };
  t.after(() => {
    console.warn = originalWarn;
  });

  await pruneRecipeRunHistory(artifactsDir);

  assert.equal(existsSync(oldRunDir), true);
  assert.equal(existsSync(anotherRunDir), true);
  assert.ok(warnings.some((warning) => warning.includes('promoted run cache is missing')));
});

async function publishPackageFixture(t: test.TestContext, name: string) {
  const testId = `${name}-${process.pid}-${Date.now()}`;
  const poolFile = path.join(farmslotRoot, 'pool', `${testId}.json`);
  const workerRepo = await mkdtemp(path.join(tmpdir(), `${testId}-worker-`));
  const taskRelDir = `test/${testId}`;
  const taskDir = path.join(farmslotRoot, '.sandbox/farmslot-farm/tasks', taskRelDir);
  const taskFile = path.join(taskDir, 'TASK.md');
  const workerTaskDir = path.join(workerRepo, '.sandbox/farmslot-farm/worker-task', taskRelDir);
  const workerArtifacts = path.join(workerTaskDir, 'artifacts');
  const slotId = `${testId}-slot`;
  t.after(async () => {
    // The pool entry goes first: a leftover one breaks other suites' slot lookups.
    await rm(poolFile, { force: true });
    await rm(taskDir, { recursive: true, force: true });
    await rm(workerRepo, { recursive: true, force: true });
  });
  await mkdir(workerArtifacts, { recursive: true });
  await mkdir(path.join(taskDir, 'artifacts'), { recursive: true });
  await writeFile(taskFile, '# publish package test\n');
  await writeFile(path.join(workerTaskDir, 'TASK.md'), '# publish package test\n');
  await writeFile(
    poolFile,
    JSON.stringify({
      machine: 'localhost',
      project: 'farmslot-farm',
      platform: 'cli',
      os: 'darwin',
      host: 'localhost',
      ssh_user: userInfo().username,
      slots: [{ id: slotId, enabled: true, repo: workerRepo, session: slotId }],
    }),
  );
  const put = async (relativePath: string, content: string | Buffer = 'x\n') => {
    await mkdir(path.dirname(path.join(workerArtifacts, relativePath)), { recursive: true });
    await writeFile(path.join(workerArtifacts, relativePath), content);
  };
  const run = makeRun({ id: testId, project: 'farmslot-farm', slotId, taskFile });
  return { taskDir, workerArtifacts, put, run };
}

function captureWarnings(t: test.TestContext): string[] {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (message?: unknown, ...rest: unknown[]) => {
    warnings.push([message, ...rest].map((part) => String(part)).join(' '));
  };
  t.after(() => {
    console.warn = originalWarn;
  });
  return warnings;
}

test('refreshArtifactMirror collects named, step-dir and top-level text and media files, not scratch trees', async (t) => {
  const { taskDir, workerArtifacts, put, run } = await publishPackageFixture(t, 'mirror-scope');
  const warnings = captureWarnings(t);
  await put(
    'evidence-manifest.json',
    JSON.stringify({
      version: 1,
      standalone: [{ label: 'Deep shot', file: 'goal/session/round-3/shots/deep.png' }],
    }),
  );
  await put('goal/session/round-3/shots/deep.png', 'png');
  await put('goal/repo-copy/src/index.ts', 'export {};\n');
  await put('goal/repo-copy/notes.md', '# scratch\n');
  await put('pr-body.md', '# PR\n');
  await put('report.md', '# Report\n');
  await put('after.png', 'png');
  await put('report.html', Buffer.alloc(13 * 1024 * 1024, 'a'));
  await put('dump.bin', 'binary');
  await put('experiment-manifest.json', '{"worker":true}\n');
  await put('recipe-run/report.md', '# Recipe run\n');
  await put('recipe-run/after-step.png', 'png');
  await put('recipe-run-baseline/summary.json', '{}\n');
  await put('recipe-library/recipes/flow.recipe.json', '{}\n');
  await put('recipe-library/node_modules/dep/index.js', 'module.exports = 1;\n');
  await put('recipe-library/vendor/.git/HEAD', 'ref: refs/heads/main\n');
  await put('recipe-harness/verify/result.json', '{}\n');
  await put('recipe-harness/source/node_modules/x/index.js', 'x\n');
  await symlink(path.join(workerArtifacts, 'report.md'), path.join(workerArtifacts, 'linked.md'));

  await refreshArtifactMirror(run);

  const has = (relativePath: string) => existsSync(path.join(taskDir, 'artifacts', relativePath));
  assert.equal(has('goal/session/round-3/shots/deep.png'), true);
  assert.equal(has('goal/repo-copy'), false);
  assert.equal(has('pr-body.md'), true);
  assert.equal(has('report.md'), true);
  assert.equal(has('evidence-manifest.json'), true);
  assert.equal(has('after.png'), true);
  assert.equal(has('report.html'), true, 'a 13 MB report is kept');
  assert.equal(has('dump.bin'), false);
  assert.equal(has('experiment-manifest.json'), false);
  assert.equal(has('linked.md'), false);
  assert.equal(has('recipe-run/report.md'), true);
  assert.equal(has('recipe-run/after-step.png'), true);
  assert.equal(has('recipe-run-baseline/summary.json'), true);
  assert.equal(has('recipe-library/recipes/flow.recipe.json'), true);
  assert.equal(has('recipe-library/node_modules'), false);
  assert.equal(has('recipe-library/vendor/.git'), false);
  assert.equal(has('recipe-harness/verify/result.json'), true);
  assert.equal(has('recipe-harness/source'), false);
  assert.ok(
    warnings.some(
      (warning) =>
        warning.includes('left out 1 top-level file(s) that are not text or media (dump.bin)') &&
        warning.includes('1 symlink(s) (linked.md)'),
    ),
    warnings.join('\n'),
  );
});

test('refreshArtifactMirror keeps subdirectory media the PR body cites without a manifest', async (t) => {
  const { taskDir, workerArtifacts, put, run } = await publishPackageFixture(t, 'mirror-cited');
  await put(
    'pr-description.md',
    [
      '## Evidence',
      '![after](artifacts/proof/after-fix.png)',
      'Recording: `.task/fix/abc/artifacts/videos/walkthrough.mp4`',
      '[Full iOS recording](scale-e2e-run/videos/recipe-run.mp4)',
      '![linked](proof/linked.png)',
      '![remote](https://example.com/artifacts/remote.png)',
      '![escape](../outside.png)',
    ].join('\n'),
  );
  await put('proof/after-fix.png', 'png');
  await put('proof/unrelated.png', 'png');
  await put('proof/real.png', 'real png');
  await symlink('real.png', path.join(workerArtifacts, 'proof/linked.png'));
  await put('videos/walkthrough.mp4', 'mp4');
  await put('scale-e2e-run/videos/recipe-run.mp4', 'mp4');
  await writeFile(path.join(path.dirname(workerArtifacts), 'outside.png'), 'outside');

  await refreshArtifactMirror(run);

  const has = (relativePath: string) => existsSync(path.join(taskDir, 'artifacts', relativePath));
  assert.equal(has('proof/after-fix.png'), true);
  assert.equal(has('videos/walkthrough.mp4'), true);
  assert.equal(has('scale-e2e-run/videos/recipe-run.mp4'), true);
  assert.equal(
    await readFile(path.join(taskDir, 'artifacts/proof/linked.png'), 'utf-8'),
    'real png',
    'a cited symlink is copied as its target',
  );
  assert.equal(has('proof/unrelated.png'), false);
  assert.equal(existsSync(path.join(taskDir, 'outside.png')), false);
});

test('refreshArtifactMirror keeps recipe packages whole by marker, within the depth bound', async (t) => {
  const { taskDir, put, run } = await publishPackageFixture(t, 'mirror-packages');
  await put('recipe-run-1/artifact-manifest.json', '{"version":1,"artifacts":[]}\n');
  await put('recipe-run-1/summary.json', '{}\n');
  await put('recipe-run-1/trace.json', '[]\n');
  await put('recipe-run-1/report.md', '# Run\n');
  await put('recipe-run-1/videos/recipe-run.mp4', 'mp4');
  await put('recipe-run-1/videos/recipe-run.mp4.timeline.json', '[]\n');
  await put('recipe-run-1/network/run-summary.json', '{}\n');
  await put('goal/repo-copy/src/index.ts', 'export {};\n');
  await put('goal/repo-copy/videos/clip.mp4', 'mp4');
  await put('deep/a/b/c/artifact-manifest.json', '{}\n');
  await put('deep/a/b/c/clip.mp4', 'mp4');

  await refreshArtifactMirror(run);

  const has = (relativePath: string) => existsSync(path.join(taskDir, 'artifacts', relativePath));
  for (const file of [
    'artifact-manifest.json',
    'summary.json',
    'trace.json',
    'report.md',
    'videos/recipe-run.mp4',
    'videos/recipe-run.mp4.timeline.json',
    'network/run-summary.json',
  ]) {
    assert.equal(has(`recipe-run-1/${file}`), true, file);
  }
  assert.equal(has('goal'), false, 'a scratch tree without markers is dropped');
  assert.equal(has('deep'), false, 'a marker past the depth bound is ignored');
});

test('refreshArtifactMirror fails when a snapshot link cannot be resolved for a reason other than dangling', async (t) => {
  const { taskDir, workerArtifacts, put, run } = await publishPackageFixture(t, 'mirror-realpath');
  await put('report.md', '# Report\n');
  await put(
    'latest-valid-recipe-run.json',
    JSON.stringify({ version: 1, runId: 'run-1', relativeArtifactRoot: 'recipe-runs/run-1' }),
  );
  await put('recipe-runs/run-1/summary.json', '{}\n');
  // The link leads through a directory the gateway may not search: realpath
  // fails with EACCES, which is not a dangling link, so the count is unknown.
  const locked = path.join(path.dirname(workerArtifacts), 'locked');
  await mkdir(path.join(locked, 'inner'), { recursive: true });
  await symlink(path.join(locked, 'inner'), path.join(workerArtifacts, 'recipe-runs/run-1/link'));
  await chmod(locked, 0o600);
  try {
    await assert.rejects(() => refreshArtifactMirror(run), /EACCES/);
  } finally {
    // Restored here: the fixture's own cleanup runs first among the t.after hooks.
    await chmod(locked, 0o700);
  }
  assert.equal(existsSync(path.join(taskDir, 'artifacts/report.md')), false);
});

test('refreshArtifactMirror counts the promoted snapshot before clearing the mirror', async (t) => {
  const { taskDir, workerArtifacts, put, run } = await publishPackageFixture(t, 'mirror-snapshot');
  await put('report.md', '# Report\n');
  await put(
    'latest-valid-recipe-run.json',
    JSON.stringify({ version: 1, runId: 'run-1', relativeArtifactRoot: 'recipe-runs/run-1' }),
  );
  await put('recipe-runs/run-1/summary.json', '{}\n');
  await put('recipe-runs/run-1/videos/run.mp4', '');
  // Sparse: the guard reads sizes from stat, so no data is written.
  await truncate(path.join(workerArtifacts, 'recipe-runs/run-1/videos/run.mp4'), 700 * 1024 ** 2);
  await put('recipe-runs/run-1/screenshots/raw.png', '');
  await truncate(
    path.join(workerArtifacts, 'recipe-runs/run-1/screenshots/raw.png'),
    2 * 1024 ** 3,
  );
  await symlink('videos', path.join(workerArtifacts, 'recipe-runs/run-1/videos-again'));
  await writeFile(path.join(taskDir, 'artifacts/previous.md'), 'previous mirror\n');

  await assert.rejects(
    () => refreshArtifactMirror(run),
    (error: Error) => {
      assert.match(error.message, /would mirror 5 file\(s\), 1\.4 GB /);
      assert.match(
        error.message,
        /Largest directories: artifacts\/recipe-runs\/run-1\/ 1\.4 GB in 3 file\(s\); artifacts\/ \(top-level files\)/,
      );
      return true;
    },
  );
  assert.equal(existsSync(path.join(taskDir, 'artifacts/report.md')), false);
  assert.equal(existsSync(path.join(taskDir, 'artifacts/previous.md')), true);
});

test('refreshArtifactMirror fails fast on an oversized package, listing the five largest directories', async (t) => {
  const { taskDir, workerArtifacts, put, run } = await publishPackageFixture(t, 'mirror-cap');
  await put('report.md', '# Report\n');
  // Sparse files: the size guard reads sizes from stat, so no data is written.
  for (let i = 1; i <= 6; i++) {
    await put(`recipe-library/scratch-${i}/blob.bin`, '');
    await truncate(
      path.join(workerArtifacts, `recipe-library/scratch-${i}/blob.bin`),
      i * 100 * 1024 ** 2,
    );
  }
  await writeFile(path.join(taskDir, 'artifacts/previous.md'), 'previous mirror\n');

  await assert.rejects(
    () => refreshArtifactMirror(run),
    (error: Error) => {
      assert.match(error.message, /publish package would mirror 7 file\(s\), 2\.1 GB from /);
      assert.match(error.message, /over the cap of 20000 files \/ 1\.0 GB/);
      assert.match(
        error.message,
        /Largest directories: artifacts\/recipe-library\/scratch-6\/ 600\.0 MB in 1 file\(s\); artifacts\/recipe-library\/scratch-5\/ 500\.0 MB/,
      );
      assert.match(error.message, /scratch-2\/ 200\.0 MB in 1 file\(s\)\. Keep clones/);
      assert.doesNotMatch(error.message, /scratch-1\//);
      return true;
    },
  );
  assert.equal(existsSync(path.join(taskDir, 'artifacts/report.md')), false);
  assert.equal(existsSync(path.join(taskDir, 'artifacts/previous.md')), true);
});
