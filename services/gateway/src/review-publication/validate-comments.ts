import type { ReviewDiffSnapshot, ReviewIssue, ReviewLineComment, Run } from '@farmslot/protocol';
import { normalizeReviewSeverity } from '@farmslot/protocol/review-approval-policy.cjs';

import { gitBranchDiff, gitExec, type GitExecDeps } from '../methods/git.js';
import { workspaceReviewGit } from '../review-workspaces/git.js';

import { rightDiffLines } from './diff-comments.js';

export async function readReviewCommentDiff(
  run: Run,
  snapshot: ReviewDiffSnapshot,
  file: string,
  dependencies?: GitExecDeps,
) {
  if (!snapshot.baseSha || !snapshot.headSha)
    throw new Error('Review diff identity is unavailable');
  const deps =
    dependencies ??
    (run.reviewWorkspace
      ? await workspaceReviewGit({
          runId: run.id,
          slotId: '',
          base: snapshot.baseSha,
          head: snapshot.headSha,
        })
      : undefined);
  if (!run.reviewWorkspace && !run.slotId) throw new Error('Review source is unavailable');
  const inventory = await gitBranchDiff(
    { slotId: run.slotId ?? '', base: snapshot.baseSha, head: snapshot.headSha },
    deps,
  );
  const oldPath = inventory.files.find((entry) => entry.path === file)?.oldPath;
  return (
    await gitExec(
      run.slotId ?? '',
      [
        'diff',
        `${snapshot.baseSha}...${snapshot.headSha}`,
        '--',
        `:(literal)${file}`,
        ...(oldPath ? [`:(literal)${oldPath}`] : []),
      ],
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

/** Body-only findings must survive publication when there is no inline location. */
export function assertReviewFindingBodies(
  issues: ReviewIssue[],
  comments: ReviewLineComment[],
  report: string,
): void {
  for (const issue of issues) {
    const inline = comments.some(
      (comment) =>
        comment.path === issue.file &&
        comment.line === issue.line &&
        comment.body === issue.description &&
        normalizeReviewSeverity(comment.severity) === normalizeReviewSeverity(issue.severity),
    );
    if (!inline && !report.includes(issue.description))
      throw new Error(
        'Review line comments disagree with authoritative findings: body-only findings must appear in the review body',
      );
  }
}
