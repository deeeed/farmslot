#!/usr/bin/env node
// CI gate: every gateway RPC method in the protocol registry must be
// classified in docs/reference/cli-protocol-method-matrix.json, and the
// generated markdown table must be in sync. Regenerate the markdown with:
//   node scripts/quality/check-method-matrix.mjs --write-markdown
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const registryPath = resolve(repoRoot, 'packages/protocol/src/rpc/registry.ts');
const matrixPath = resolve(repoRoot, 'docs/reference/cli-protocol-method-matrix.json');
const markdownPath = resolve(repoRoot, 'docs/reference/cli-protocol-method-matrix.md');

const SURFACES = new Set(['typed-command', 'tui', 'rpc-only', 'na']);

function registryMethods() {
  const source = readFileSync(registryPath, 'utf8');
  // Take every quoted string inside the Methods block so a prettier-wrapped
  // property (key and value on separate lines) is still counted.
  const start = source.indexOf('export const Methods = {');
  const end = source.indexOf('} as const', start);
  if (start === -1 || end === -1) {
    throw new Error(`Methods block not found in ${registryPath} — did the registry format change?`);
  }
  const block = source
    .slice(start, end)
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
  const methods = [...block.matchAll(/'([^']+)'/g)].map((match) => match[1]);
  if (methods.length === 0) {
    throw new Error(`No methods parsed from ${registryPath} — did the registry format change?`);
  }
  const seen = new Set();
  for (const method of methods) {
    if (seen.has(method)) {
      throw new Error(`Duplicate method value in registry: ${method}`);
    }
    seen.add(method);
  }
  return methods;
}

function renderMarkdown(matrix, methods) {
  const groups = new Map();
  for (const method of methods) {
    const prefix = method.split('.')[0];
    if (!groups.has(prefix)) groups.set(prefix, []);
    groups.get(prefix).push(method);
  }
  const lines = [
    '# CLI Protocol Method Matrix',
    '',
    'Generated from [`cli-protocol-method-matrix.json`](cli-protocol-method-matrix.json) —',
    'edit the JSON, then run `node scripts/quality/check-method-matrix.mjs --write-markdown`.',
    'CI fails when a registry method is missing from the matrix or this file is stale.',
    '',
  ];
  for (const [surface, description] of Object.entries(matrix.surfaces)) {
    lines.push(`- **${surface}** — ${description}`);
  }
  lines.push('');
  for (const [prefix, group] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(
      `## ${prefix}.*`,
      '',
      '| Method | Surface | CLI command | TUI | Note |',
      '| --- | --- | --- | --- | --- |',
    );
    for (const method of group) {
      const entry = matrix.methods[method];
      const tui = entry.surface === 'tui' || entry.tui ? 'yes' : '';
      lines.push(
        `| \`${method}\` | ${entry.surface} | ${entry.command ? `\`${entry.command}\`` : ''} | ${tui} | ${entry.note ?? ''} |`,
      );
    }
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

const methods = registryMethods();
const matrix = JSON.parse(readFileSync(matrixPath, 'utf8'));

const problems = [];
for (const method of methods) {
  const entry = matrix.methods[method];
  if (!entry) {
    problems.push(`missing from matrix: ${method}`);
    continue;
  }
  if (!SURFACES.has(entry.surface)) {
    problems.push(`invalid surface '${entry.surface}' for ${method}`);
  }
  const nonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;
  if (entry.surface === 'typed-command' && !nonEmptyString(entry.command)) {
    problems.push(`typed-command without a command string: ${method}`);
  }
  if (entry.surface === 'na' && !nonEmptyString(entry.note)) {
    problems.push(`na without a justification note: ${method}`);
  }
  if ('command' in entry && !nonEmptyString(entry.command)) {
    problems.push(`empty or non-string command for ${method}`);
  }
  if ('note' in entry && !nonEmptyString(entry.note)) {
    problems.push(`empty or non-string note for ${method}`);
  }
  if ('tui' in entry && typeof entry.tui !== 'boolean') {
    problems.push(`non-boolean tui flag for ${method}`);
  }
  const unknownFields = Object.keys(entry).filter(
    (field) => !['surface', 'command', 'note', 'tui'].includes(field),
  );
  if (unknownFields.length > 0) {
    problems.push(`unknown field(s) ${unknownFields.join(', ')} on ${method}`);
  }
}
const known = new Set(methods);
for (const method of Object.keys(matrix.methods)) {
  if (!known.has(method)) problems.push(`matrix entry for unknown method: ${method}`);
}

if (problems.length > 0) {
  console.error(`Protocol method matrix guard failed (${problems.length} problem(s)):`);
  for (const problem of problems) console.error(`  ${problem}`);
  console.error(
    'Classify new methods in docs/reference/cli-protocol-method-matrix.json, then regenerate the markdown with --write-markdown.',
  );
  process.exit(1);
}

// Format through the repo prettier config so the generated file is stable
// under `yarn format` (table cells get column-aligned).
const prettier = await import('prettier');
const prettierConfig = await prettier.resolveConfig(markdownPath);
const markdown = await prettier.format(renderMarkdown(matrix, methods), {
  ...prettierConfig,
  parser: 'markdown',
});
if (process.argv.includes('--write-markdown')) {
  writeFileSync(markdownPath, markdown);
  console.log(`Wrote ${markdownPath}`);
} else if (readFileSync(markdownPath, 'utf8') !== markdown) {
  console.error(
    'cli-protocol-method-matrix.md is stale. Regenerate with: node scripts/quality/check-method-matrix.mjs --write-markdown',
  );
  process.exit(1);
} else {
  console.log(`Protocol method matrix guard passed (${methods.length} methods classified).`);
}
