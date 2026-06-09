// self-review/issues.ts — parse self-review issue bullets from markdown artifacts.

import type { SelfReviewIssue } from '@farmslot/protocol';

export function parseSelfReviewIssueBullets(content: string): SelfReviewIssue[] {
  const issues: SelfReviewIssue[] = [];
  const issueRegex = /[-*]\s+(?:\*\*([^*\n]+)\*\*|`([^`\n]+)`)\s*[—–-]\s*(.*)/g;
  let match: RegExpExecArray | null;
  while ((match = issueRegex.exec(content)) !== null) {
    const loc = (match[1] ?? match[2] ?? '').trim();
    const desc = match[3].trim();
    const lineMatch = loc.match(/^(.*):(\d+)$/);
    issues.push({
      file: lineMatch?.[1] || loc,
      line: lineMatch ? parseInt(lineMatch[2], 10) : undefined,
      description: desc,
    });
  }
  return issues;
}
