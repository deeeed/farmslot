import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import * as proofUtils from './antigravity-proof-utils.mts';
import {
  assertCleanTrackedSource,
  createFrozenProofCheckout,
  verifyFrozenModuleResolution,
  verifyFrozenProofCheckout,
  withFrozenProofCheckout,
} from './antigravity-proof-utils.mts';

test('frozen proof checkout isolates tracked bytes, verifies CJS/ESM resolution, scopes cleanup to owned checkout, and reports cleanup failure', async () => {
  const origin = mkdtempSync(path.join(tmpdir(), 'agy-frozen-origin-'));
  const unrelatedWorktree = path.join(tmpdir(), `agy-unrelated-wt-${process.pid}-${Date.now()}`);
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', origin, ...args], { encoding: 'utf8' }).trim();
  let cleanupSnapshot: (() => void) | undefined;
  let failedSnapshotRoot: string | undefined;
  try {
    git('init', '-q', '-b', 'main');
    writeFileSync(path.join(origin, 'package.json'), JSON.stringify({ name: 'origin-fixture' }));
    mkdirSync(path.join(origin, 'packages', 'demo-pkg', 'dist'), { recursive: true });
    writeFileSync(
      path.join(origin, 'packages', 'demo-pkg', 'package.json'),
      JSON.stringify({
        name: '@farmslot/demo-pkg',
        exports: {
          '.': {
            import: './dist/index.mjs',
            require: './dist/index.cjs',
          },
        },
      }),
    );
    writeFileSync(
      path.join(origin, 'packages', 'demo-pkg', 'dist', 'index.mjs'),
      'export const version = "v1";\n',
    );
    writeFileSync(
      path.join(origin, 'packages', 'demo-pkg', 'dist', 'index.cjs'),
      'module.exports = { version: "v1" };\n',
    );
    writeFileSync(path.join(origin, 'tracked.txt'), 'committed-v1\n');
    git('add', '.');
    git(
      '-c',
      'user.name=Proof',
      '-c',
      'user.email=proof@localhost',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-qm',
      'initial commit',
    );

    // Create an unrelated dirty linked worktree in the same repo to confirm it can never be targeted.
    git('worktree', 'add', '--detach', unrelatedWorktree, 'HEAD');
    writeFileSync(path.join(unrelatedWorktree, 'tracked.txt'), 'unrelated-dirty-work\n');

    // 1. No arbitrary-path cleanup helper or standalone cleanup CLI exists.
    assert.equal('removeFrozenProofCheckout' in proofUtils, false);
    const utilsScriptPath = fileURLToPath(
      new URL('./antigravity-proof-utils.mts', import.meta.url),
    );
    spawnSync(
      process.execPath,
      ['--import', 'tsx', utilsScriptPath, 'cleanup', origin, unrelatedWorktree],
      { encoding: 'utf8' },
    );
    assert.equal(existsSync(unrelatedWorktree), true);
    assert.equal(
      readFileSync(path.join(unrelatedWorktree, 'tracked.txt'), 'utf8'),
      'unrelated-dirty-work\n',
    );

    const { sourceSha, sourceTreeSha } = assertCleanTrackedSource(origin);

    // 2. withFrozenProofCheckout scopes creation and cleanup strictly to one operation lifetime
    //    and leaves unrelated worktrees untouched.
    let scopedSnapshotRoot = '';
    await withFrozenProofCheckout(
      origin,
      (prepared) => {
        scopedSnapshotRoot = prepared.snapshotRoot;
        assert.equal(prepared.sourceSha, sourceSha);
        assert.equal(prepared.sourceTreeSha, sourceTreeSha);
        assert.equal(existsSync(prepared.snapshotRoot), true);
      },
      { installAndBuild: false },
    );
    assert.equal(existsSync(scopedSnapshotRoot), false);
    assert.equal(existsSync(unrelatedWorktree), true);

    const snapshot = createFrozenProofCheckout(origin, sourceSha, sourceTreeSha, {
      installAndBuild: false,
    });
    cleanupSnapshot = snapshot.cleanup;

    // 3. Linking node_modules/@farmslot/demo-pkg back to origin (the old shortcut) MUST be refused.
    const snapshotScopeDir = path.join(snapshot.snapshotRoot, 'node_modules', '@farmslot');
    mkdirSync(snapshotScopeDir, { recursive: true });
    symlinkSync(
      path.join(origin, 'packages', 'demo-pkg'),
      path.join(snapshotScopeDir, 'demo-pkg'),
      'dir',
    );
    assert.throws(
      () =>
        verifyFrozenModuleResolution(snapshot.snapshotRoot, [
          { specifier: '@farmslot/demo-pkg', loader: 'cjs' },
          { specifier: '@farmslot/demo-pkg', loader: 'esm' },
        ]),
      /escaped detached checkout/,
    );

    // 4. Linking inside the detached checkout passes both CJS require and ESM package-export resolution.
    rmSync(path.join(snapshotScopeDir, 'demo-pkg'), { force: true });
    symlinkSync(
      path.join(snapshot.snapshotRoot, 'packages', 'demo-pkg'),
      path.join(snapshotScopeDir, 'demo-pkg'),
      'dir',
    );
    const resolved = verifyFrozenModuleResolution(snapshot.snapshotRoot, [
      { specifier: '@farmslot/demo-pkg', loader: 'cjs' },
      { specifier: '@farmslot/demo-pkg', loader: 'esm' },
    ]);
    assert.equal(resolved.length, 2);
    assert.ok(resolved[0].resolvedPath.startsWith(`${snapshot.snapshotRoot}${path.sep}`));
    assert.ok(resolved[1].resolvedPath.startsWith(`${snapshot.snapshotRoot}${path.sep}`));
    assert.ok(resolved[0].resolvedPath.endsWith(path.join('dist', 'index.cjs')));
    assert.ok(resolved[1].resolvedPath.endsWith(path.join('dist', 'index.mjs')));

    // 5. Mutating the originating checkout while a proof runs leaves the detached checkout clean.
    writeFileSync(path.join(origin, 'tracked.txt'), 'mutated-during-proof\n');
    assert.throws(() => assertCleanTrackedSource(origin), /dirty tracked working tree/);
    assert.equal(
      readFileSync(path.join(snapshot.snapshotRoot, 'tracked.txt'), 'utf8'),
      'committed-v1\n',
    );
    const preSeal = verifyFrozenProofCheckout(snapshot.snapshotRoot, sourceSha, sourceTreeSha);
    assert.equal(preSeal.sourceSha, sourceSha);
    assert.equal(preSeal.sourceTreeSha, sourceTreeSha);

    // 6. Mutating the detached checkout itself causes pre-seal verification to refuse sealing.
    writeFileSync(path.join(snapshot.snapshotRoot, 'tracked.txt'), 'tampered-snapshot\n');
    assert.throws(
      () => verifyFrozenProofCheckout(snapshot.snapshotRoot, sourceSha, sourceTreeSha),
      /dirty tracked working tree/,
    );

    // Clean up this owned snapshot cleanly and restore origin tracked.txt for the failure-reporting test.
    snapshot.cleanup();
    cleanupSnapshot = undefined;
    assert.equal(existsSync(snapshot.snapshotRoot), false);
    writeFileSync(path.join(origin, 'tracked.txt'), 'committed-v1\n');

    // 7. If git worktree remove fails on an owned checkout, cleanup reports the error loudly.
    const doomed = createFrozenProofCheckout(origin, sourceSha, sourceTreeSha, {
      installAndBuild: false,
    });
    failedSnapshotRoot = doomed.snapshotRoot;
    rmSync(path.join(origin, '.git', 'worktrees', path.basename(doomed.snapshotRoot)), {
      recursive: true,
      force: true,
    });
    assert.throws(() => doomed.cleanup(), /Failed to remove detached proof worktree/);
  } finally {
    cleanupSnapshot?.();
    if (failedSnapshotRoot) rmSync(failedSnapshotRoot, { recursive: true, force: true });
    if (existsSync(unrelatedWorktree)) {
      spawnSync('git', ['-C', origin, 'worktree', 'remove', '--force', unrelatedWorktree], {
        stdio: 'ignore',
      });
      rmSync(unrelatedWorktree, { recursive: true, force: true });
    }
    rmSync(origin, { recursive: true, force: true });
  }
});
