import assert from 'node:assert/strict';
import test from 'node:test';

import type { ReviewDiffSnapshot } from '@farmslot/protocol';

import { makeRun } from '../run-completion/test-fixtures.js';

import {
  assertReviewCommentLines,
  assertReviewFindingBodies,
  readReviewCommentDiff,
} from './validate-comments.js';

const snapshot: ReviewDiffSnapshot = {
  baseSha: 'a'.repeat(40),
  headSha: 'b'.repeat(40),
  capturedAt: '2026-10-22T00:00:00.000Z',
  source: 'github-pr',
};
const comment = {
  path: 'src/translate-error.ts',
  line: 381,
  severity: 'minor',
  body: 'Handle the missing value.',
};

test('a renamed destination keeps its source in the diff limiter', async () => {
  const run = makeRun();
  run.reviewWorkspace = {
    workspaceId: 'rename',
    machine: 'local',
    executionNodeId: 'local',
    checkoutPath: '/fixture/source',
    taskPath: '/fixture/task',
    artifactPath: '/fixture/task/artifacts',
  };
  const read = (_run: typeof run, scope: ReviewDiffSnapshot, file: string) =>
    readReviewCommentDiff(run, scope, file, {
      runCommand: async (args) => {
        let stdout = snapshot.baseSha ?? '';
        if (args[0] === 'rev-parse' && args.includes(`${snapshot.headSha}^{commit}`))
          stdout = snapshot.headSha ?? '';
        if (args[0] === 'diff') {
          stdout = args.includes('--name-status')
            ? 'R095\told.ts\tnew.ts\n'
            : args.includes('--numstat')
              ? '1\t1\told.ts => new.ts\n'
              : args.includes(':(literal)old.ts')
                ? '@@ -15 +15 @@\n-old\n+new\n'
                : '@@ -0,0 +1,2 @@\n+first\n+second\n';
        }
        return { stdout, stderr: '' };
      },
    });
  await assert.rejects(
    assertReviewCommentLines(run, [{ ...comment, path: 'new.ts', line: 1 }], snapshot, read),
    /RIGHT-side diff/,
  );
  await assertReviewCommentLines(run, [{ ...comment, path: 'new.ts', line: 15 }], snapshot, read);
});

test('inline review comments resolve to added or context lines at the frozen head, never a deleted or out-of-diff line', async () => {
  const run = makeRun();
  const requested: unknown[] = [];
  const read = async (_run: typeof run, scope: ReviewDiffSnapshot, file: string) => {
    requested.push([scope.baseSha, scope.headSha, file]);
    return '@@ -380,3 +380,3 @@\n context\n-old\n+added\n context\n';
  };
  await assertReviewCommentLines(run, [comment, { ...comment, line: 382 }], snapshot, read);
  assert.deepEqual(requested, [[snapshot.baseSha, snapshot.headSha, comment.path]]);
  await assert.rejects(
    assertReviewCommentLines(run, [{ ...comment, line: 383 }], snapshot, read),
    /RIGHT-side diff/,
  );
  await assert.rejects(
    assertReviewCommentLines(
      run,
      [comment],
      snapshot,
      async () => '@@ -381,1 +380,0 @@\n-deleted\n',
    ),
    /review body/,
  );
  await assert.rejects(
    assertReviewCommentLines(run, [comment], snapshot, async () => ''),
    /RIGHT-side diff/,
  );
  await assert.rejects(
    assertReviewCommentLines(run, [comment], snapshot, async () => {
      throw new Error('Frozen head is unavailable');
    }),
    /head is unavailable/,
  );
});

test('a body-only finding keeps its ask without inventing an inline line', () => {
  const issue = {
    file: 'PR description',
    description: 'Remove the unsupported coverage claim',
    severity: 'minor' as const,
  };
  assert.doesNotThrow(() => assertReviewFindingBodies([issue], [], issue.description));
  assert.throws(() => assertReviewFindingBodies([issue], [], 'No findings'), /review body/);
});
