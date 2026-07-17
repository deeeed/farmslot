import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { frontmatterPlatforms, frontmatterRunMode, parseMarkdownDocument } from './frontmatter.js';
import { FARMSLOT_FLOW_PREFIXES, inferFlowFromBasename } from './infer.js';
import type { LintExecutionTemplatesResult, LintIssue } from './types.js';

const CHECKBOX_RE = /^\s*[-*]\s+\[([ xX])\]\s+\S/;

function collectMarkdownTargets(target: string): string[] {
  if (!existsSync(target)) return [];
  const st = statSync(target);
  if (st.isFile()) return target.endsWith('.md') ? [target] : [];
  if (!st.isDirectory()) return [];

  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < 3) walk(full, depth + 1);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith('.md')) out.push(full);
    }
  };
  walk(target, 0);
  return out.sort((a, b) => a.localeCompare(b));
}

function lintOne(filePath: string): LintIssue[] {
  const issues: LintIssue[] = [];
  const basename = path.basename(filePath);
  const text = readFileSync(filePath, 'utf8');
  const { frontmatter, body } = parseMarkdownDocument(text);

  if (!inferFlowFromBasename(basename)) {
    issues.push({
      path: filePath,
      severity: 'error',
      message: `filename must start with a Farmslot flow name (${FARMSLOT_FLOW_PREFIXES.join(', ')})`,
    });
  }

  if (/fix-ticket/i.test(text)) {
    issues.push({
      path: filePath,
      severity: 'error',
      message: 'contains deprecated fix-ticket terminology; use fix-bug',
    });
  }

  if (frontmatter) {
    if (frontmatter.runMode != null || frontmatter.run_mode != null) {
      if (!frontmatterRunMode(frontmatter)) {
        issues.push({
          path: filePath,
          severity: 'error',
          message: 'frontmatter runMode must be autonomous|interactive|validation',
        });
      }
    }
    if (frontmatter.platforms != null && !frontmatterPlatforms(frontmatter)) {
      issues.push({
        path: filePath,
        severity: 'error',
        message: 'frontmatter platforms must be a non-empty string array',
      });
    }
    if (frontmatter.flow != null && typeof frontmatter.flow !== 'string') {
      issues.push({
        path: filePath,
        severity: 'error',
        message: 'frontmatter flow must be a string',
      });
    }
  }

  const lines = body.split(/\r?\n/);
  let checkboxCount = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (!/^\s*[-*]\s+\[/.test(line)) continue;
    if (CHECKBOX_RE.test(line)) {
      checkboxCount += 1;
      continue;
    }
    issues.push({
      path: filePath,
      severity: 'error',
      message: `line ${i + 1}: checkbox must be '- [ ] text' or '- [x] text'`,
    });
  }

  if (checkboxCount === 0) {
    issues.push({
      path: filePath,
      severity: 'error',
      message: 'no parseable checkbox lines (`- [ ]` / `- [x]`)',
    });
  }

  return issues;
}

/** Lint optional frontmatter and parseable checkbox structure for a file or directory. */
export function lintExecutionTemplates(target: string): LintExecutionTemplatesResult {
  const files = collectMarkdownTargets(path.resolve(target));
  if (files.length === 0) {
    return {
      ok: false,
      filesChecked: 0,
      issues: [
        {
          path: path.resolve(target),
          severity: 'error',
          message: 'no Markdown templates found',
        },
      ],
    };
  }

  const issues = files.flatMap(lintOne);
  return {
    ok: issues.every((issue) => issue.severity !== 'error'),
    filesChecked: files.length,
    issues,
  };
}
