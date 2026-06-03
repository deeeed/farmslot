import type { PRReviewThread, ReviewLineComment } from '@farmslot/protocol';

export function reviewCommentKey(comment: ReviewLineComment): string {
  return `${comment.path}\u0000${comment.line}\u0000${comment.body}`;
}

export function reviewCommentsByFile(
  comments: readonly ReviewLineComment[],
): Map<string, ReviewLineComment[]> {
  const map = new Map<string, ReviewLineComment[]>();
  for (const comment of comments) {
    const list = map.get(comment.path) ?? [];
    list.push(comment);
    map.set(comment.path, list);
  }
  return map;
}

export function reviewCommentCountByFile(
  commentsByFile: ReadonlyMap<string, readonly ReviewLineComment[]>,
): Map<string, number> {
  const map = new Map<string, number>();
  for (const [path, comments] of commentsByFile) {
    map.set(path, comments.length);
  }
  return map;
}

export function reviewThreadsForFile(
  commentsByFile: ReadonlyMap<string, readonly ReviewLineComment[]>,
  filePath: string,
  timestamp: () => string = () => new Date().toISOString(),
): PRReviewThread[] {
  const comments = commentsByFile.get(filePath) ?? [];
  return comments.map((comment, index) => ({
    id: `review-${index}-${comment.line}`,
    path: comment.path,
    line: comment.line,
    resolved: false,
    outdated: false,
    comments: [
      {
        id: index,
        body: `**[${comment.severity}]** ${comment.body}`,
        author: 'Review Agent',
        createdAt: timestamp(),
        updatedAt: timestamp(),
      },
    ],
  }));
}
