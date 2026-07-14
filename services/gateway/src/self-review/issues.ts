// self-review/issues.ts — parse self-review issue bullets from markdown artifacts.

import type { SelfReviewIssue } from '@farmslot/protocol';

/**
 * Remove fenced code blocks (``` or ~~~, three or more marker chars, up to
 * three leading spaces, unterminated fences run to EOF). Fences are stripped
 * BEFORE section extraction so a `## Example` heading inside a fence cannot
 * truncate the Issues section, and diff snippets cannot produce phantom items.
 */
function stripFencedBlocks(content: string): string {
  const out: string[] = [];
  let fence: { char: string; len: number } | null = null;
  for (const line of content.split('\n')) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) {
      if (marker && marker[1][0] === fence.char && marker[1].length >= fence.len) fence = null;
      continue;
    }
    if (marker) {
      fence = { char: marker[1][0], len: marker[1].length };
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

/**
 * Extract the body of the `## Issues` section (any h2 heading starting with
 * "Issues", e.g. "## Issues Found by Self-Review", up to three leading spaces
 * per CommonMark). Returns null when no such heading exists so callers can
 * fall back to whole-document parsing for artifacts that predate the
 * sectioned template.
 */
function issuesSection(content: string): string | null {
  const heading = content.match(/^ {0,3}##\s+Issues\b.*$/im);
  if (!heading || heading.index === undefined) return null;
  const body = content.slice(heading.index + heading[0].length);
  const nextHeading = body.match(/^ {0,3}##\s+/m);
  return nextHeading?.index === undefined ? body : body.slice(0, nextHeading.index);
}

const ITEM_START = /^ {0,3}(?:[-*]|\d+[.)])\s+(.*)$/;

/** Split a scope into top-level list items, folding indented non-item continuation lines. */
function listItems(scope: string): string[] {
  const items: string[] = [];
  let current: string[] | null = null;
  for (const line of scope.split('\n')) {
    const start = line.match(ITEM_START);
    if (start) {
      if (current) items.push(current.join(' '));
      current = [start[1].trim()];
      continue;
    }
    if (current && /^[ \t]+\S/.test(line)) {
      current.push(line.trim());
      continue;
    }
    if (current) {
      items.push(current.join(' '));
      current = null;
    }
  }
  if (current) items.push(current.join(' '));
  return items;
}

/** Prefer a path-looking backtick token (has a slash, extension, or :line) over identifiers. */
function pathToken(text: string): string | null {
  const tokens = [...text.matchAll(/`([^`\s]+)`/g)].map((m) => m[1]);
  return tokens.find((t) => /[/\\]|:\d+$|\.[a-zA-Z]{1,6}$/.test(t)) ?? tokens[0] ?? null;
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
  const stripped = stripFencedBlocks(content);
  const scope = issuesSection(stripped) ?? stripped;
  const issues: SelfReviewIssue[] = [];
  for (const text of listItems(scope)) {
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
    // the description and use the first path-looking backticked token (usually
    // a file:line reference) or the bold title as the location.
    const title = text.match(/^\*\*(.+?)\*\*/);
    pushIssue(issues, (pathToken(text) ?? title?.[1] ?? '').trim(), text);
  }
  return issues;
}
