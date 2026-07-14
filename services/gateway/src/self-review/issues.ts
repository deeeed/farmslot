// self-review/issues.ts — parse self-review issue bullets from markdown artifacts.

import type { SelfReviewIssue } from '@farmslot/protocol';

/**
 * Extract the body of the `## Issues` section (any heading starting with
 * "Issues", e.g. "## Issues Found by Self-Review"). Returns null when no such
 * heading exists so callers can fall back to whole-document parsing for
 * artifacts that predate the sectioned template.
 */
function issuesSection(content: string): string | null {
  const heading = content.match(/^##\s+Issues\b.*$/im);
  if (!heading || heading.index === undefined) return null;
  const body = content.slice(heading.index + heading[0].length);
  const nextHeading = body.match(/^##\s+/m);
  return nextHeading?.index === undefined ? body : body.slice(0, nextHeading.index);
}

function pushIssue(issues: SelfReviewIssue[], loc: string, description: string): void {
  const lineMatch = loc.match(/^(.*):(\d+)$/);
  issues.push({
    file: lineMatch?.[1] || loc,
    line: lineMatch ? parseInt(lineMatch[2], 10) : undefined,
    description,
  });
}

export function parseSelfReviewIssueBullets(content: string): SelfReviewIssue[] {
  // Scope to the Issues section when present — Validation/Evidence sections use
  // the same `- **x** — y` bullet shape and must not be mistaken for findings.
  // Fenced code blocks are illustration (diff snippets contain `-` lines), not
  // findings — drop them before scanning for list items.
  const scope = (issuesSection(content) ?? content).replace(
    /^[ \t]*```[^\n]*\n[\s\S]*?^[ \t]*```[ \t]*$/gm,
    '',
  );
  const issues: SelfReviewIssue[] = [];
  // Top-level list item: `- `, `* `, or numbered `1. `/`1) `, plus its indented
  // continuation lines.
  const itemRegex = /^(?:[-*]|\d+[.)])\s+([^\n]*(?:\n[ \t]+[^\n]*)*)/gm;
  let match: RegExpExecArray | null;
  while ((match = itemRegex.exec(scope)) !== null) {
    const text = match[1].replace(/\s*\n\s*/g, ' ').trim();
    if (!text) continue;
    // Template placeholder bullets like `- <empty for PASS>` are not findings.
    if (/^<[^>]*>$/.test(text)) continue;
    // Canonical shape from the reviewer template: `**file:line** — description`
    // (or backticked location).
    const strict = text.match(/^(?:\*\*([^*]+)\*\*|`([^`]+)`)\s*[—–-]\s*(.*)$/);
    if (strict) {
      pushIssue(issues, (strict[1] ?? strict[2] ?? '').trim(), strict[3].trim());
      continue;
    }
    // Title-style item (`1. **Some defect.** body…`): keep the whole item as
    // the description and use the first backticked token (usually a file:line
    // reference) or the bold title as the location.
    const pathToken = text.match(/`([^`\s]+)`/);
    const title = text.match(/^\*\*(.+?)\*\*/);
    pushIssue(issues, (pathToken?.[1] ?? title?.[1] ?? '').trim(), text);
  }
  return issues;
}
