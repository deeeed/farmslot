#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const result = spawnSync('node', ['scripts/docs/generate-template-variables.mjs'], {
  cwd: repoRoot,
  encoding: 'utf8',
});
if (result.status !== 0) {
  console.error(result.stderr || result.stdout);
  process.exit(result.status ?? 1);
}

const diff = spawnSync(
  'git',
  [
    'diff',
    '--quiet',
    '--',
    'docs/reference/template-variables.generated.md',
    'apps/docs/docs/reference/template-variables-catalog.generated.md',
  ],
  { cwd: repoRoot },
);
if (diff.status !== 0) {
  console.error('TEMPLATE_VARIABLES_DOCS_STALE');
  console.error('Run yarn docs:template-vars and commit the generated catalog.');
  process.exit(1);
}

console.log('TEMPLATE_VARIABLES_DOCS_FRESH');
