import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assertCleanTrackedSource,
  createFrozenProofCheckout,
  verifyFrozenProofCheckout,
} from './antigravity-proof-utils.mts';

test('frozen proof checkout isolates tested bytes from concurrent originating-repo edits and refuses pre-seal mutation', () => {
  const origin = mkdtempSync(path.join(tmpdir(), 'agy-frozen-origin-'));
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', origin, ...args], { encoding: 'utf8' }).trim();
  let cleanupSnapshot: (() => void) | undefined;
  try {
    git('init', '-q', '-b', 'main');
    writeFileSync(path.join(origin, 'tracked.txt'), 'committed-v1\n');
    git('add', 'tracked.txt');
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
    const snapshot = createFrozenProofCheckout(origin, sourceSha, sourceTreeSha);
    cleanupSnapshot = snapshot.cleanup;

    // Mutating the originating checkout while a proof runs must not alter the detached checkout
    // or cause a mismatch in its pre-seal verification.
    writeFileSync(path.join(origin, 'tracked.txt'), 'mutated-during-proof\n');
    assert.throws(() => assertCleanTrackedSource(origin), /dirty tracked working tree/);
    assert.equal(
      readFileSync(path.join(snapshot.snapshotRoot, 'tracked.txt'), 'utf8'),
      'committed-v1\n',
    );
    const preSeal = verifyFrozenProofCheckout(snapshot.snapshotRoot, sourceSha, sourceTreeSha);
    assert.equal(preSeal.sourceSha, sourceSha);
    assert.equal(preSeal.sourceTreeSha, sourceTreeSha);

    // Mutating the detached checkout itself must cause pre-seal verification to refuse sealing.
    writeFileSync(path.join(snapshot.snapshotRoot, 'tracked.txt'), 'tampered-snapshot\n');
    assert.throws(
      () => verifyFrozenProofCheckout(snapshot.snapshotRoot, sourceSha, sourceTreeSha),
      /dirty tracked working tree/,
    );
  } finally {
    cleanupSnapshot?.();
    rmSync(origin, { recursive: true, force: true });
  }
});
