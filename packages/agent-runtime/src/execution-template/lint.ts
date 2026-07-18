import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { frontmatterPlatforms, frontmatterRunMode, parseMarkdownDocument } from './frontmatter.js';
import {
  catalogRelativeId,
  FARMSLOT_FLOW_PREFIXES,
  inferFlowFromBasename,
  inferFlowFromPath,
  inferRunModeFromBasename,
} from './infer.js';
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

const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/** Lint template TEXT under a (possibly virtual) path — used by `create` to validate before writing. */
export function lintExecutionTemplateText(filePath: string, text: string): LintIssue[] {
  const issues: LintIssue[] = [];
  const basename = path.basename(filePath);
  const { frontmatter, body } = parseMarkdownDocument(text);

  // The parser treats an unterminated frontmatter fence as body — surface it
  // instead of silently linting metadata as prose.
  if (/^\uFEFF?---\r?\n/.test(text) && frontmatter === null) {
    issues.push({
      path: filePath,
      severity: 'error',
      message: 'unterminated frontmatter block (opening --- without closing ---)',
    });
  }

  const pathFlow = inferFlowFromPath(filePath);
  if (!pathFlow) {
    issues.push({
      path: filePath,
      severity: 'error',
      message: `path must encode a Farmslot flow — flow-prefixed filename or flow directory (${FARMSLOT_FLOW_PREFIXES.join(', ')})`,
    });
  }
  // fix-bug/dev.md would create under one flow and catalog under another —
  // the parent directory wins, so a basename claiming a DIFFERENT flow is a
  // misleading name.
  const basenameFlow = inferFlowFromBasename(basename);
  if (pathFlow && basenameFlow && pathFlow !== basenameFlow) {
    issues.push({
      path: filePath,
      severity: 'error',
      message: `filename flow '${basenameFlow}' contradicts the flow directory '${pathFlow}'`,
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
    if (frontmatter.id != null) {
      const id = frontmatter.id;
      const unsafe =
        typeof id !== 'string' ||
        !SAFE_ID_RE.test(id) ||
        id.split('/').includes('..') ||
        id.includes('\\');
      if (unsafe) {
        issues.push({
          path: filePath,
          severity: 'error',
          message:
            'frontmatter id must be a safe catalog id (alphanumeric start; letters, digits, ./_- only; no .. segments)',
        });
      }
    }
    const fmFlow = typeof frontmatter.flow === 'string' ? frontmatter.flow.trim() : null;
    const fileFlow = inferFlowFromPath(filePath);
    if (fmFlow && fileFlow && fmFlow !== fileFlow) {
      issues.push({
        path: filePath,
        severity: 'error',
        message: `frontmatter flow '${fmFlow}' contradicts the path's flow '${fileFlow}'`,
      });
    }
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

  // Interactive templates are conversation-driven and legitimately have no
  // checklist; only non-interactive templates must carry parseable checkboxes.
  const runMode = frontmatterRunMode(frontmatter) ?? inferRunModeFromBasename(basename);
  if (checkboxCount === 0 && runMode !== 'interactive') {
    issues.push({
      path: filePath,
      severity: 'error',
      message: 'no parseable checkbox lines (`- [ ]` / `- [x]`)',
    });
  }

  return issues;
}

function lintOne(filePath: string): LintIssue[] {
  return lintExecutionTemplateText(filePath, readFileSync(filePath, 'utf8'));
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

  // Two files that canonicalize to the same catalog id (dev-interactive.md vs
  // dev.interactive.md) would resolve by filename order silently — surface the
  // collision at authoring time. Layout per file mirrors the resolver: a file
  // under a flow-named directory is flow-tree, otherwise worker-flat.
  const root = path.resolve(target);
  const byId = new Map<string, string[]>();
  for (const file of files) {
    // Mirror the resolver's id derivation exactly: an explicit frontmatter id
    // wins over the path-derived catalog id — otherwise this check misses
    // identical explicit ids and falsely flags path collisions whose explicit
    // ids differ.
    const { frontmatter: fm } = parseMarkdownDocument(readFileSync(file, 'utf8'));
    const explicitId = typeof fm?.id === 'string' ? fm.id.trim() : '';
    const parent = path.basename(path.dirname(file)).toLowerCase();
    const layout = (FARMSLOT_FLOW_PREFIXES as readonly string[]).includes(parent)
      ? ('flow-tree' as const)
      : ('worker-flat' as const);
    const rel =
      layout === 'flow-tree' ? path.join(parent, path.basename(file)) : path.basename(file);
    const id = explicitId || catalogRelativeId(rel, layout);
    byId.set(id, [...(byId.get(id) ?? []), file]);
  }
  for (const [id, paths] of byId) {
    if (paths.length < 2) continue;
    issues.push({
      path: root,
      severity: 'error',
      message: `duplicate catalog id '${id}' from: ${paths.map((f) => path.relative(root, f)).join(', ')}`,
    });
  }

  return {
    ok: issues.every((issue) => issue.severity !== 'error'),
    filesChecked: files.length,
    issues,
  };
}
