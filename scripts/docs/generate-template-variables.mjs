#!/usr/bin/env node
/**
 * Signal-only template reference — one repo file + one docs site file.
 * Edit scripts/docs/template-variable-catalog.mjs, then: yarn docs:template-vars
 */
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DISPATCH_CMD,
  HOOKS_AND_RECIPE,
  SECONDARY_TEMPLATES,
  SYNTAX_RULE,
  TASK_FORMAT,
  WORKER_TASK,
} from './template-variable-catalog.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** @param {import('./template-variable-catalog.mjs').CatalogSection} section */
function renderSection(section) {
  const lines = [`## ${section.title} (${section.syntax})`, ''];
  for (const group of section.groups) {
    const note = group.note ? ` (${group.note})` : '';
    lines.push(`- **${group.scope}:** \`${group.vars}\`${note}`);
  }
  return lines.join('\n');
}

function buildBody() {
  return `# Template variables

<!-- GENERATED — scripts/docs/template-variable-catalog.mjs | yarn docs:template-vars -->

${SYNTAX_RULE}

## TASK format {#task-format}

${TASK_FORMAT}

${renderSection(WORKER_TASK)}

${renderSection(HOOKS_AND_RECIPE)}

${renderSection(DISPATCH_CMD)}

${renderSection(SECONDARY_TEMPLATES)}
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
