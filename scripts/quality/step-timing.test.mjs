import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  normalizeTimingsDir,
  REPO_ROOT,
  TIMINGS_DIR_ENV,
  uniqueArtifactPath,
  writeTimingArtifact,
} from './lib/step-timing.mjs';

const LIB_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'lib/step-timing.mjs');

test('REPO_ROOT points at the repository root', () => {
  assert.equal(existsSync(path.join(REPO_ROOT, 'package.json')), true);
  assert.equal(existsSync(path.join(REPO_ROOT, 'scripts/quality/lib/step-timing.mjs')), true);
});

test('an unset timings dir stays unset', () => {
  const env = {};
  assert.equal(normalizeTimingsDir(env), null);
  assert.equal(TIMINGS_DIR_ENV in env, false);
});

test('a relative timings dir resolves against the repo root, not the cwd', () => {
  const env = { [TIMINGS_DIR_ENV]: 'artifacts/timings' };
  const resolved = normalizeTimingsDir(env);
  assert.equal(resolved, path.join(REPO_ROOT, 'artifacts/timings'));
  assert.equal(
    env[TIMINGS_DIR_ENV],
    resolved,
    'the absolute form must be pinned back into env so spawned children inherit it',
  );
});

test('an absolute timings dir is left alone and is idempotent', () => {
  const absolute = path.join(tmpdir(), 'farmslot-timings-abs');
  const env = { [TIMINGS_DIR_ENV]: absolute };
  assert.equal(normalizeTimingsDir(env), absolute);
  assert.equal(normalizeTimingsDir(env), absolute, 'normalizing twice must not double-resolve');
});

test('artifact names avoid collisions instead of overwriting', () => {
  const taken = new Set();
  const exists = (candidate) => taken.has(candidate);
  const dir = '/tmp/example';

  const first = uniqueArtifactPath(dir, 'tsx-tests-gateway.json', exists);
  assert.equal(first, path.join(dir, 'tsx-tests-gateway.json'));
  taken.add(first);

  const second = uniqueArtifactPath(dir, 'tsx-tests-gateway.json', exists);
  assert.equal(second, path.join(dir, 'tsx-tests-gateway-2.json'));
  taken.add(second);

  const third = uniqueArtifactPath(dir, 'tsx-tests-gateway.json', exists);
  assert.equal(third, path.join(dir, 'tsx-tests-gateway-3.json'));
});

test('a repeated write produces a second artifact rather than clobbering the first', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'farmslot-timings-write-'));
  try {
    const env = { [TIMINGS_DIR_ENV]: dir };
    const first = writeTimingArtifact('tsx-tests-gateway.json', { kind: 'a' }, env);
    const second = writeTimingArtifact('tsx-tests-gateway.json', { kind: 'b' }, env);

    assert.notEqual(first, second);
    assert.equal(JSON.parse(readFileSync(first, 'utf8')).kind, 'a', 'first write was overwritten');
    assert.equal(JSON.parse(readFileSync(second, 'utf8')).kind, 'b');
    assert.equal(
      JSON.parse(readFileSync(second, 'utf8')).artifactPath,
      second,
      'the artifact records where it actually landed',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The bug this pins: the quality gates spawn children in every workspace, and a
// relative FARMSLOT_QUALITY_TIMINGS_DIR used to be re-resolved against each
// child's cwd — so one configured directory became a `.sandbox` tree under
// services/gateway, every package, and every app. Two processes with different
// cwds must now agree on one location.
test('processes with different cwds write to the same resolved directory', () => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'farmslot-timings-cwd-'));
  // A single path segment on purpose: cleanup removes exactly this directory and
  // can never reach into a real tracked tree.
  const relativeDir = `.timings-cwd-probe-${process.pid}`;
  const expectedDir = path.join(REPO_ROOT, relativeDir);
  const otherCwd = path.join(REPO_ROOT, 'services', 'gateway');
  const strayDir = path.join(otherCwd, relativeDir);

  const probe = path.join(scratch, 'probe.mjs');
  writeFileSync(
    probe,
    `import { writeTimingArtifact } from ${JSON.stringify(LIB_PATH)};
     process.stdout.write(String(writeTimingArtifact('probe.json', { cwd: process.cwd() })));`,
  );

  try {
    const run = (cwd) =>
      spawnSync(process.execPath, [probe], {
        cwd,
        encoding: 'utf8',
        env: { ...process.env, [TIMINGS_DIR_ENV]: relativeDir },
        stdio: ['ignore', 'pipe', 'pipe'],
      }).stdout.trim();

    const fromRoot = run(REPO_ROOT);
    const fromWorkspace = run(otherCwd);

    assert.equal(path.dirname(fromRoot), expectedDir);
    assert.equal(
      path.dirname(fromWorkspace),
      expectedDir,
      `a child running in ${otherCwd} must not create its own copy of the directory`,
    );
    assert.equal(
      existsSync(strayDir),
      false,
      'the workspace cwd must not gain a stray timings tree',
    );
    assert.notEqual(fromRoot, fromWorkspace, 'the second write must not clobber the first');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    rmSync(expectedDir, { recursive: true, force: true });
    rmSync(strayDir, { recursive: true, force: true });
  }
});

test('mkdir is scoped to the resolved directory', () => {
  const base = mkdtempSync(path.join(tmpdir(), 'farmslot-timings-mkdir-'));
  try {
    const nested = path.join(base, 'a', 'b');
    const env = { [TIMINGS_DIR_ENV]: nested };
    const written = writeTimingArtifact('quality-steps.json', { kind: 'quality-steps' }, env);
    assert.equal(path.dirname(written), nested);
    assert.equal(existsSync(written), true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('a directory that already exists is reused rather than rejected', () => {
  const base = mkdtempSync(path.join(tmpdir(), 'farmslot-timings-reuse-'));
  try {
    mkdirSync(path.join(base, 'out'), { recursive: true });
    const env = { [TIMINGS_DIR_ENV]: path.join(base, 'out') };
    assert.ok(writeTimingArtifact('quality-steps.json', { kind: 'quality-steps' }, env));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
