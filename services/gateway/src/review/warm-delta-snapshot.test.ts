import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';

import type { ExecResult, ReviewDiffSnapshot } from '@farmslot/protocol';

const core = await import('../core/exec.js');
const slotWrites = await import('../methods/dispatch/slot-file-write.js');
const gitMethods = await import('../methods/git.js');

let repo = '';
mock.module('../core/exec.js', {
  namedExports: {
    ...core,
    execOnSlot: async (_vars: unknown, command: string): Promise<ExecResult> => {
      const result = spawnSync('bash', ['-c', command], {
        cwd: repo,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      });
      return { exitCode: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
    },
  },
});
mock.module('../methods/dispatch/slot-file-write.js', {
  namedExports: {
    ...slotWrites,
    writeTextFileOnSlot: async () => undefined,
    writeLargeTextFileOnSlot: async () => undefined,
  },
});
mock.module('../methods/git.js', {
  namedExports: { ...gitMethods, refreshRemoteBaseRef: async () => undefined },
});

const { captureReviewDeltaSnapshot, captureReviewSnapshot } = await import('./snapshots.js');
const { reviewFinalSnapshotMatchesPreparedPackage } = await import('../run-engine/gate-policy.js');
const { makeVars } = await import('../runners/test-fixtures.js');

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

async function commit(file: string, text: string): Promise<string> {
  await writeFile(path.join(repo, file), text);
  git('add', file);
  git('commit', '-q', '-m', file);
  return git('rev-parse', 'HEAD');
}

test('a WARM re-review with no requested base records the base branch, so a pass on the package head counts', async (t) => {
  repo = await mkdtemp(path.join(tmpdir(), 'warm-delta-base-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  await commit('base.ts', 'export const base = 1;\n');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('checkout', '-q', '-b', 'feature');
  await commit('feature.ts', 'export const feature = 1;\n');
  // Run 26c4343a's shape: the reviewer already passed this head, and a requested
  // WARM review re-checks it with no stacked or repeat-review base.
  const head = await commit('fix.ts', 'export const fix = 1;\n');
  const vars = makeVars({ dispatchCmd: '' });

  const delta = await captureReviewDeltaSnapshot(vars, 'temp/task', 4, null, {
    lastReviewedHeadSha: head,
  });
  const prepared = await captureReviewSnapshot(vars, 'temp/task', 0, null, { mode: 'cold' });

  assert.equal(prepared.snapshot.baseRef, 'origin/main');
  assert.equal(delta.snapshot.baseRef, 'origin/main');
  assert.equal(delta.snapshot.baseSha, head);
  assert.equal(delta.snapshot.headSha, head);
  const session = {
    mode: 'warm' as const,
    continuity: 'resumed' as const,
    reviewId: 'pipeline-review-run',
    sessionId: 'reviewer-session',
    lastReviewedHeadSha: head,
  };
  const review = {
    id: 'pipeline-review-run',
    source: 'human-gate' as const,
    loopNumber: 1,
    verdict: 'pass' as const,
    unresolvedCount: 0,
    mode: 'warm' as const,
    reviewerSessionId: 'reviewer-session',
    reviewedHeadSha: head,
    session,
    reviewSnapshot: delta.snapshot,
  };
  const preparedPackage = {
    headSha: head,
    reviewSnapshot: prepared.snapshot satisfies ReviewDiffSnapshot,
  };
  assert.equal(reviewFinalSnapshotMatchesPreparedPackage(review, preparedPackage), true);
});
