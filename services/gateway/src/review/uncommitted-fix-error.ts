/** The fix is still in the worktree; refusing it must preserve the blocked fix loop. */
export class UncommittedReviewFixError extends Error {
  override name = 'UncommittedReviewFixError';
  constructor(head: string, dirtyPaths: string[]) {
    super(
      `Re-review refused: fix not committed. HEAD is still ${head.slice(0, 8)} and the slot worktree is dirty: ${dirtyPaths.slice(0, 10).join(', ')}. Commit the fix before requesting a re-review.`,
    );
  }
}
