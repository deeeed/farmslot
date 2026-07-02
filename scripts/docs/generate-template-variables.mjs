#!/usr/bin/env node
/**
 * Single-source template reference for repo + docs site.
 * Edit scripts/docs/template-variable-catalog.mjs, then: yarn docs:template-vars
 */
import { writeFileSync } from 'node:fs';
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
    '| Variable | Flows | Description | Example / empty |',
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

function buildBody() {
  return `# Template variables

<!-- GENERATED — source: scripts/docs/template-variable-catalog.mjs | yarn docs:template-vars -->

Three placeholder families — do not mix syntax: worker TASK \`{{VAR}}\` (writer.ts), hooks/recipe \`{{var}}\` (hooks.ts), pool dispatch \`{var}\` (slot-common.sh). Extend farms via \`project.json\` \`vars\` (both \`{{key}}\` and \`{{KEY}}\`).

## TASK format {#task-format}

Gateway progress parsing: \`##\`+ headings = phases; \`- [ ]\` / \`- [x]\` = steps; checkboxes before any heading → **Checklist** phase; fenced blocks and \`<details>\` skipped; informational sections (acceptance criteria, description, task, …) skipped. \`SIGNAL.json\` is terminal only — checkboxes carry ongoing progress.

## Worker TASK variables

${renderTable(WORKER_TASK_VARIABLES)}

## Hook / recipe_run variables

${renderTable(HOOK_AND_RECIPE_VARIABLES)}

## Pool dispatch_cmd variables

| Placeholder | Flows | Description |
| --- | --- | --- |
${DISPATCH_CMD_VARIABLES.map(
  (row) => `| \`{${row.name}}\` | ${row.flows} | ${row.description} |`,
).join('\n')}

## Secondary in-run templates

${renderTable(SECONDARY_TEMPLATE_VARIABLES)}
`;
}

function writeRepoReference(body) {
  const target = join(repoRoot, 'docs/reference/template-variables.md');
  writeFileSync(target, body);
  console.log(`generated ${target}`);
}

function writeDocusaurusPage(body) {
  const withoutTitle = body.replace(/^# Template variables\n\n/, '');
  const target = join(repoRoot, 'apps/docs/docs/reference/template-variables.generated.md');
  const content = `---
# GENERATED — scripts/docs/template-variable-catalog.mjs | yarn docs:template-vars
title: Template variables
sidebar_label: Template variables
slug: /reference/template-variables
---

${withoutTitle}`;
  writeFileSync(target, content);
  console.log(`generated ${target}`);
}

const body = buildBody();
writeRepoReference(body);
writeDocusaurusPage(body);
