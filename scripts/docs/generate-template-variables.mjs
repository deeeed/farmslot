#!/usr/bin/env node
/**
 * Generate template variable reference tables from scripts/docs/template-variable-catalog.mjs
 * and placeholder usage scans across committed worker templates.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DISPATCH_CMD_VARIABLES,
  HOOK_AND_RECIPE_VARIABLES,
  SECONDARY_TEMPLATE_VARIABLES,
  WORKER_TASK_VARIABLES,
} from './template-variable-catalog.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function formatPlaceholder(name) {
  if (name.includes(' ') || name.includes('<')) return `\`${name}\``;
  return `\`{{${name}}}\``;
}

/** @param {import('./template-variable-catalog.mjs').VarRow[]} rows */
function renderTable(rows) {
  const lines = [
    '| Variable | Flows / site | Description | Example / empty |',
    '| --- | --- | --- | --- |',
  ];
  for (const row of rows) {
    const example = row.example ? row.example : row.empty ? `empty: ${row.empty}` : '—';
    lines.push(
      `| ${formatPlaceholder(row.name)} | ${row.flows} | ${row.description} | ${example} |`,
    );
  }
  return lines.join('\n');
}

/** @returns {Map<string, Set<string>>} */
function scanWorkerTemplateUsage() {
  /** @type {Map<string, Set<string>>} */
  const usage = new Map();
  const roots = [
    join(repoRoot, 'templates/worker'),
    join(repoRoot, 'projects/farmslot-farm/templates/worker'),
  ];

  const placeholder = /\{\{([A-Za-z0-9_]+)\}\}/g;

  for (const root of roots) {
    let files = [];
    try {
      files = readdirSync(root).filter((name) => name.endsWith('.md'));
    } catch {
      continue;
    }
    for (const file of files) {
      const text = readFileSync(join(root, file), 'utf8');
      for (const match of text.matchAll(placeholder)) {
        const key = match[1];
        if (!usage.has(key)) usage.set(key, new Set());
        usage.get(key).add(file);
      }
    }
  }
  return usage;
}

function renderUsageAppendix(usage) {
  const lines = ['## Placeholder usage in committed templates', ''];
  lines.push(
    'Scanned `templates/worker/` and `projects/farmslot-farm/templates/worker/`. Project-owned farms may define additional placeholders via `project.json` `vars`.',
    '',
    '| Placeholder | Used in |',
    '| --- | --- |',
  );
  for (const [key, files] of [...usage.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`| \`{{${key}}}\` | ${[...files].sort().join(', ')} |`);
  }
  return lines.join('\n');
}

function buildBody(usage) {
  return `# Template variables (generated)

<!-- GENERATED FILE — do not edit. Source: scripts/docs/template-variable-catalog.mjs -->
<!-- Regenerate: yarn docs:template-vars -->

Three placeholder families exist in Farmslot. **Do not mix syntax** across families.

| Family | Syntax | Expanded when | Primary source |
| --- | --- | --- | --- |
| Worker TASK.md | \`{{VAR}}\` | Task write (dispatch) | \`services/gateway/src/tasks/writer.ts\` |
| Hooks / fixtures / recipe_run | \`{{var}}\` | Hook or recipe command expansion | \`services/gateway/src/core/hooks.ts\` |
| Pool dispatch_cmd | \`{var}\` | Bash dispatch wrapper | \`scripts/lib/slot-common.sh\` |

Project integrators usually care about the **worker TASK** table first, then hook/recipe vars in \`project.json\`.

## Worker TASK.md variables

${renderTable(WORKER_TASK_VARIABLES)}

### PR integration note examples

\`PR_INTEGRATION_NOTE\` is informational — prepare never hard-fails on merge state.

| GitHub state | Typical note |
| --- | --- |
| Clean + mergeable | \`mergeable=MERGEABLE, mergeStateStatus=CLEAN\` |
| Mergeable but blocked | \`mergeable=MERGEABLE, mergeStateStatus=BLOCKED — merge blocked (often CI or branch protection); review code independently\` |
| Conflicts | \`mergeable=CONFLICTING, … — author must resolve merge conflicts before merge\` |
| Behind base | \`mergeStateStatus=BEHIND — branch is behind base; author may need to update before merge\` |

## Hook, fixture, and recipe_run variables

${renderTable(HOOK_AND_RECIPE_VARIABLES)}

## Pool dispatch_cmd variables

Single-brace placeholders in \`dispatch_cmd\` / recycle wrappers:

| Placeholder | Flows / site | Description |
| --- | --- | --- |
${DISPATCH_CMD_VARIABLES.map(
  (row) => `| \`{${row.name}}\` | ${row.flows} | ${row.description} |`,
).join('\n')}

## Secondary in-run templates

Written mid-run (CI-fix, self-review). Same \`{{VAR}}\` syntax; smaller var sets:

${renderTable(SECONDARY_TEMPLATE_VARIABLES)}

${renderUsageAppendix(usage)}
`;
}

function writeRepoReference(body) {
  const target = join(repoRoot, 'docs/reference/template-variables.generated.md');
  writeFileSync(target, body);
  console.log(`generated ${target}`);
}

function writeDocusaurusPage(body) {
  const withoutTitle = body.replace(/^# Template variables \(generated\)\n\n/, '');
  const target = join(repoRoot, 'apps/docs/docs/reference/template-variables-catalog.generated.md');
  const content = `---
# GENERATED FILE — do not edit. Source: scripts/docs/template-variable-catalog.mjs
# Regenerated by yarn docs:template-vars on docs start/build.
title: Template variable catalog
sidebar_label: Template variable catalog
---

${withoutTitle}`;
  writeFileSync(target, content);
  console.log(`generated ${target}`);
}

const usage = scanWorkerTemplateUsage();
const body = buildBody(usage);
writeRepoReference(body);
writeDocusaurusPage(body);
