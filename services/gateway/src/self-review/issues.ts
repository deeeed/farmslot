// self-review/issues.ts — parse self-review issue bullets from markdown artifacts.

import type { SelfReviewIssue } from '@farmslot/protocol';

export function parseSelfReviewIssueBullets(content: string): SelfReviewIssue[] {
  const issues: SelfReviewIssue[] = [];
  const issueRegex = /[-*]\s+\*\*([^*]+)\*\*\s*[—–-]\s*(.*)/g;
  let match: RegExpExecArray | null;
  while ((match = issueRegex.exec(content)) !== null) {
    const loc = match[1].trim();
    const desc = match[2].trim();
    const [file, lineStr] = loc.split(':');
    issues.push({
      file: file || loc,
      line: lineStr ? parseInt(lineStr, 10) || undefined : undefined,
      description: desc,
    });
  }
  return issues;
}
