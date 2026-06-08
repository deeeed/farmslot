#!/usr/bin/env node
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../apps/companion/src');

const THRESHOLDS = {
  appRoute: 200,
  screen: 1800,
  controller: 1500,
  component: 500,
  sharedModule: 300,
};

const args = new Set(process.argv.slice(2));
const strict = args.has('--strict');
const scope = args.has('--scope') ? process.argv[process.argv.indexOf('--scope') + 1] : 'all';

/** Workspace refactor scope: migrated slot/family surfaces only. */
const WORKSPACE_PREFIXES = [
  'app/slot/',
  'app/family/',
  'features/workspace-shared/',
  'features/slot-workspace/',
  'features/family-workspace/',
];

function walk(dir, files = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, files);
      continue;
    }
    if (!entry.name.endsWith('.tsx') && !entry.name.endsWith('.ts')) continue;
    files.push(full);
  }
  return files;
}

function lineCount(file) {
  return readFileSync(file, 'utf8').split('\n').length;
}

function inWorkspaceScope(rel) {
  return WORKSPACE_PREFIXES.some((prefix) => rel.startsWith(prefix));
}

function thresholdFor(rel) {
  if (rel.startsWith('app/slot/') || rel.startsWith('app/family/')) {
    return { limit: THRESHOLDS.appRoute, kind: 'route' };
  }
  if (rel.endsWith('Screen.tsx')) {
    return { limit: THRESHOLDS.screen, kind: 'screen' };
  }
  if (rel.includes('/use-') && rel.endsWith('-controller.ts')) {
    return { limit: THRESHOLDS.controller, kind: 'controller' };
  }
  if (rel.includes('/components/') && rel.endsWith('-panels.tsx')) {
    // Mechanical extraction debt — warn until panels are split further.
    return scope === 'all' ? { limit: THRESHOLDS.component, kind: 'panel' } : null;
  }
  if (rel.startsWith('features/workspace-shared/')) {
    return { limit: THRESHOLDS.sharedModule, kind: 'shared' };
  }
  return null;
}

const violations = [];
for (const file of walk(ROOT)) {
  const rel = path.relative(ROOT, file);
  if (scope === 'workspace' && !inWorkspaceScope(rel)) continue;

  const rule = thresholdFor(rel);
  if (!rule) continue;

  const lines = lineCount(file);
  if (lines > rule.limit) {
    violations.push({ file: rel, lines, limit: rule.limit, kind: rule.kind });
  }
}

if (violations.length === 0) {
  console.log(`companion structure (${scope}${strict ? ', strict' : ''}): ok`);
  process.exit(0);
}

const label = strict ? 'FAIL' : 'WARN';
for (const v of violations) {
  console.log(`${label} [${v.kind}] ${v.file}: ${v.lines} lines (limit ${v.limit})`);
}

if (strict) {
  process.exit(1);
}
