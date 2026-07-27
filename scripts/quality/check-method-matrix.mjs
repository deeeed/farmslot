#!/usr/bin/env node
// CI gate: every gateway RPC method in the protocol registry must be
// classified in docs/reference/cli-protocol-method-matrix.json, and the
// generated markdown table + cli-exemptions must be in sync. Regenerate with:
//   node scripts/quality/check-method-matrix.mjs --write-markdown
//
// Classification contract (allowlist, not blocklist):
//   - typed-command / tui → dedicated CLI surface
//   - na → deliberate UI-only exemption (reason required; mirrored in cli-exemptions.json)
//   - rpc-only → interim raw `farmslot rpc` reachability (not a typed command yet)
// A registry method with no matrix entry fails. UI-only exemptions live in
// docs/reference/cli-exemptions.json (generated from surface=na entries).
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const registryPath = resolve(repoRoot, 'packages/protocol/src/rpc/registry.ts');
const matrixPath = resolve(repoRoot, 'docs/reference/cli-protocol-method-matrix.json');
const markdownPath = resolve(repoRoot, 'docs/reference/cli-protocol-method-matrix.md');
const exemptionsPath = resolve(repoRoot, 'docs/reference/cli-exemptions.json');

const SURFACES = new Set(['typed-command', 'tui', 'rpc-only', 'na']);
/** Surfaces that count as a dedicated CLI operator surface. */
const CLI_SURFACES = new Set(['typed-command', 'tui']);

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
const exemptionMethods = {};
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
  // Every method must have a dedicated CLI surface, an interim rpc-only entry,
  // or a recorded UI-only exemption (surface=na → cli-exemptions.json).
  if (!CLI_SURFACES.has(entry.surface) && entry.surface !== 'rpc-only' && entry.surface !== 'na') {
    problems.push(`method has neither CLI surface nor cli-exemption: ${method}`);
  }
  if (entry.surface === 'na') {
    exemptionMethods[method] = { reason: entry.note };
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

// Roadmap must stay on typed commands — never park it in cli-exemptions.
for (const method of Object.keys(exemptionMethods)) {
  if (method.startsWith('roadmap.')) {
    problems.push(`roadmap method must not be in cli-exemptions: ${method}`);
  }
}
for (const method of methods) {
  if (!method.startsWith('roadmap.')) continue;
  const entry = matrix.methods[method];
  if (!entry) continue;
  if (entry.surface !== 'typed-command') {
    problems.push(`roadmap method must be typed-command (got ${entry.surface}): ${method}`);
  }
}

const exemptionsDoc = {
  description:
    'UI-only gateway methods deliberately without a dedicated farmslot subcommand. Generated from surface=na entries in cli-protocol-method-matrix.json by scripts/quality/check-method-matrix.mjs. Every registry method must have a typed CLI surface, an interim rpc-only classification, or an entry here with a reason.',
  methods: Object.fromEntries(
    Object.keys(exemptionMethods)
      .sort((a, b) => a.localeCompare(b))
      .map((method) => [method, exemptionMethods[method]]),
  ),
};
const exemptionsJson = `${JSON.stringify(exemptionsDoc, null, 2)}\n`;

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
const write = process.argv.includes('--write-markdown');
if (write) {
  writeFileSync(markdownPath, markdown);
  writeFileSync(exemptionsPath, exemptionsJson);
  console.log(`Wrote ${markdownPath}`);
  console.log(`Wrote ${exemptionsPath}`);
} else {
  let stale = false;
  if (readFileSync(markdownPath, 'utf8') !== markdown) {
    console.error(
      'cli-protocol-method-matrix.md is stale. Regenerate with: node scripts/quality/check-method-matrix.mjs --write-markdown',
    );
    stale = true;
  }
  let existingExemptions = '';
  try {
    existingExemptions = readFileSync(exemptionsPath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      console.error(
        'cli-exemptions.json is missing. Regenerate with: node scripts/quality/check-method-matrix.mjs --write-markdown',
      );
      stale = true;
    } else {
      throw err;
    }
  }
  if (existingExemptions && existingExemptions !== exemptionsJson) {
    console.error(
      'cli-exemptions.json is stale. Regenerate with: node scripts/quality/check-method-matrix.mjs --write-markdown',
    );
    stale = true;
  }
  if (stale) process.exit(1);
  console.log(
    `Protocol method matrix guard passed (${methods.length} methods classified; ${Object.keys(exemptionMethods).length} UI-only exemptions).`,
  );
}
