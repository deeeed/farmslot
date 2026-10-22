import type { ReviewDiffSnapshot, ReviewLineComment, Run } from '@farmslot/protocol';

import { gitExec } from '../methods/git.js';
import { workspaceReviewGit } from '../review-workspaces/git.js';

import { rightDiffLines } from './diff-comments.js';

export async function readReviewCommentDiff(run: Run, snapshot: ReviewDiffSnapshot, file: string) {
  if (!snapshot.baseSha || !snapshot.headSha)
    throw new Error('Review diff identity is unavailable');
  const deps = run.reviewWorkspace
    ? await workspaceReviewGit({
        runId: run.id,
        slotId: '',
        base: snapshot.baseSha,
        head: snapshot.headSha,
      })
    : undefined;
  if (!run.reviewWorkspace && !run.slotId) throw new Error('Review source is unavailable');
  return (
    await gitExec(
      run.slotId ?? '',
      ['diff', `${snapshot.baseSha}...${snapshot.headSha}`, '--', file],
      { maxBuffer: 10 * 1024 * 1024 },
      deps,
    )
  ).stdout;
}

/** Use frozen commits and the publication resolver, never the mutable worktree. */
export async function assertReviewCommentLines(
  run: Run,
  comments: ReviewLineComment[],
  snapshot: ReviewDiffSnapshot,
  readDiff = readReviewCommentDiff,
): Promise<void> {
  await Promise.all(
    [...new Set(comments.map((comment) => comment.path))].map(async (file) => {
      const lines = rightDiffLines(await readDiff(run, snapshot, file));
      for (const comment of comments.filter((item) => item.path === file)) {
        if (!lines.has(comment.line))
          throw new Error(
            `Review comment ${file}:${comment.line} is outside the RIGHT-side diff at ${snapshot.headSha}; put the note in the review body`,
          );
      }
    }),
  );
}
