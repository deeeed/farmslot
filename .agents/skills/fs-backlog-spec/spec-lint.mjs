#!/usr/bin/env node
// Deterministic lint for backlog spec files (.backlog/specs/**). Rules only —
// heuristic judgment lives in SKILL.md. Exit 0 clean, exit 1 with one line per
// violation (`<file>:<line>: <rule>: <excerpt>`), exit 2 on usage error.

import { readFileSync, realpathSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/**
 * Parse the `## Acceptance Criteria` section with the SAME rules as the
 * gateway's extractBacklogAcceptanceCriteria (services/gateway/src/backlog/
 * store.ts): stop at the next `#`/`##` heading, strip a leading `-`/`*`
 * marker, keep every remaining nonblank line as its own criterion. Parity
 * matters because the filed item's parsed AC must equal what was linted.
 * Returns entries with their 1-based source line for diagnostics.
 */
export function parseAcceptanceCriteria(markdown) {
  const lines = markdown.split(/\r?\n/);
  const headingIndex = lines.findIndex((line) => /^##\s+Acceptance Criteria\s*$/i.test(line));
  if (headingIndex < 0) return { headingLine: null, criteria: [] };
  const criteria = [];
  for (let i = headingIndex + 1; i < lines.length; i += 1) {
    if (/^#{1,2}\s+\S/.test(lines[i])) break;
    const text = lines[i].replace(/^\s*[-*]\s+/, '').trim();
    if (text) criteria.push({ line: i + 1, text });
  }
  return { headingLine: headingIndex + 1, criteria };
}

// A criterion must carry a concrete check: an inline-code command/test/grep/
// file reference, or an explicit artifact:/recipe: reference. The reference
// must have real content — empty backticks or a bare `artifact:` prove nothing.
const CHECK_MARKER = /`[^`\s][^`]*`|\b(artifact|recipe):\s*\S/i;

// Conditions no worker or reviewer can verify inside one run.
const FORBIDDEN = [
  [/\bafter merge\b/i, 'after-merge condition'],
  [/\bpost-merge\b/i, 'post-merge condition'],
  [/\b\d+-day\b/i, 'multi-day duration'],
  [/\boperator enables\b/i, 'operator-enable condition'],
  [/\bmonitor(ing)?\s+(for|over)\b/i, 'open-ended monitoring'],
  [/\bsoak\b/i, 'soak-period dependence'],
];

export function lintSpecText(markdown) {
  const violations = [];
  const { headingLine, criteria } = parseAcceptanceCriteria(markdown);
  if (headingLine === null) {
    violations.push({
      line: 1,
      rule: 'missing-acceptance-criteria',
      excerpt: 'no `## Acceptance Criteria` heading',
    });
  } else if (criteria.length === 0) {
    violations.push({
      line: headingLine,
      rule: 'empty-acceptance-criteria',
      excerpt: 'no criteria lines under the heading',
    });
  }
  for (const { line, text } of criteria) {
    if (!CHECK_MARKER.test(text)) {
      violations.push({ line, rule: 'no-check-marker', excerpt: text.slice(0, 80) });
    }
    for (const [pattern, label] of FORBIDDEN) {
      if (pattern.test(text)) violations.push({ line, rule: label, excerpt: text.slice(0, 80) });
    }
  }
  const lines = markdown.split(/\r?\n/);
  const ngIndex = lines.findIndex((line) => /^##\s+Non-goals\s*$/i.test(line));
  if (ngIndex < 0) {
    violations.push({ line: 1, rule: 'missing-non-goals', excerpt: 'no `## Non-goals` section' });
  } else {
    const body = [];
    for (let i = ngIndex + 1; i < lines.length; i += 1) {
      if (/^#{1,2}\s+\S/.test(lines[i])) break;
      if (lines[i].trim()) body.push(lines[i]);
    }
    if (body.length === 0) {
      violations.push({
        line: ngIndex + 1,
        rule: 'empty-non-goals',
        excerpt: '`## Non-goals` has no content',
      });
    }
  }
  return violations;
}

// Exact resolved-path equality: importing this module (e.g. from the test
// file) must never trigger the CLI, and an inherited env var must never
// silently disable linting.
const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
  } catch {
    // argv[1] does not resolve to a real file — not this module.
    return false;
  }
})();
if (isMain) {
  const args = process.argv.slice(2);
  const printAc = args.includes('--print-ac');
  const files = args.filter((a) => a !== '--print-ac');
  if (files.length === 0) {
    console.error('usage: spec-lint.mjs [--print-ac] <spec.md> [more.md ...]');
    process.exit(2);
  }
  let failed = false;
  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, 'utf-8');
    } catch (err) {
      // One unreadable file must not hide violations in the rest of the batch.
      console.error(`${file}:0: unreadable: ${err.message}`);
      failed = true;
      continue;
    }
    if (printAc) {
      for (const { text: t } of parseAcceptanceCriteria(text).criteria) console.log(t);
      continue;
    }
    const violations = lintSpecText(text);
    for (const v of violations) console.error(`${file}:${v.line}: ${v.rule}: ${v.excerpt}`);
    if (violations.length > 0) failed = true;
    else
      console.log(
        `PASS ${file}: ${parseAcceptanceCriteria(text).criteria.length} acceptance criteria`,
      );
  }
  process.exit(failed ? 1 : 0);
}
