import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assertCleanTrackedSource,
  createFrozenProofCheckout,
  removeFrozenProofCheckout,
  verifyFrozenModuleResolution,
  verifyFrozenProofCheckout,
} from './antigravity-proof-utils.mts';

test('frozen proof checkout isolates tracked bytes, verifies CJS/ESM module resolution, and reports cleanup failure', () => {
  const origin = mkdtempSync(path.join(tmpdir(), 'agy-frozen-origin-'));
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', origin, ...args], { encoding: 'utf8' }).trim();
  let cleanupSnapshot: (() => void) | undefined;
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

    const { sourceSha, sourceTreeSha } = assertCleanTrackedSource(origin);
    const snapshot = createFrozenProofCheckout(origin, sourceSha, sourceTreeSha, {
      installAndBuild: false,
    });
    cleanupSnapshot = snapshot.cleanup;

    // 1. Linking node_modules/@farmslot/demo-pkg back to origin (the old shortcut) MUST be refused.
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

    // 2. Linking inside the detached checkout passes both CJS require and ESM package-export resolution.
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

    // 3. Mutating the originating checkout while a proof runs leaves the detached checkout clean.
    writeFileSync(path.join(origin, 'tracked.txt'), 'mutated-during-proof\n');
    assert.throws(() => assertCleanTrackedSource(origin), /dirty tracked working tree/);
    assert.equal(
      readFileSync(path.join(snapshot.snapshotRoot, 'tracked.txt'), 'utf8'),
      'committed-v1\n',
    );
    const preSeal = verifyFrozenProofCheckout(snapshot.snapshotRoot, sourceSha, sourceTreeSha);
    assert.equal(preSeal.sourceSha, sourceSha);
    assert.equal(preSeal.sourceTreeSha, sourceTreeSha);

    // 4. Mutating the detached checkout itself causes pre-seal verification to refuse sealing.
    writeFileSync(path.join(snapshot.snapshotRoot, 'tracked.txt'), 'tampered-snapshot\n');
    assert.throws(
      () => verifyFrozenProofCheckout(snapshot.snapshotRoot, sourceSha, sourceTreeSha),
      /dirty tracked working tree/,
    );

    // 5. Cleanup failures (non-zero git worktree remove) are reported instead of silently discarded.
    assert.throws(
      () => removeFrozenProofCheckout(origin, path.join(origin, 'does-not-exist-worktree')),
      /Failed to remove detached proof worktree/,
    );
  } finally {
    cleanupSnapshot?.();
    rmSync(origin, { recursive: true, force: true });
  }
});
