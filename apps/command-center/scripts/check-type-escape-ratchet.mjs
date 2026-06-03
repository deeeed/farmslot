#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path, { dirname } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const commandCenterRoot = dirname(scriptDir);
const repoRoot = path.resolve(commandCenterRoot, '../..');
const baselinePath = path.join(commandCenterRoot, 'scripts/type-escape-baseline.json');
const productionRoots = [
  'packages/cli/src',
  'services/gateway/src',
  'services/node/src',
  'packages/protocol/src',
  'packages/recipe-harness/src',
  'apps/command-center/ui/src',
];
const ignoredSegments = new Set(['node_modules', 'dist', 'coverage']);
const ignoredSuffixes = ['.test.ts', '.test.tsx', '.d.ts'];
const ignoredRelativePrefixes = ['ui/src/dev/'];

// Known limitation: these dependency-free regexes scan raw source, so strings/comments
// that contain type-looking text can match. CODE_QUALITY.md documents how to handle
// false positives without weakening the production-code guard.
const escapePatterns = [
  { kind: 'as-any', pattern: /\bas\s+any\b/g },
  { kind: 'as-unknown', pattern: /\bas\s+unknown\b/g },
  { kind: 'type-any', pattern: /:\s*any\b/g },
  { kind: 'generic-any', pattern: /[<,]\s*any\s*(?=[>,])/g },
  { kind: 'generic-bound-any', pattern: /\b(?:extends|=)\s*any\b/g },
];

function isIgnoredFile(rel) {
  return ignoredRelativePrefixes.some((prefix) => rel.startsWith(prefix));
}

function isTypeScriptSource(entryName) {
  return entryName.endsWith('.ts') || entryName.endsWith('.tsx');
}

function walk(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(repoRoot, full).split(path.sep).join('/');
    if (entry.isDirectory()) {
      if (ignoredSegments.has(entry.name) || isIgnoredFile(`${rel}/`)) continue;
      out.push(...walk(full));
      continue;
    }
    if (!entry.isFile() || !isTypeScriptSource(entry.name)) continue;
    if (isIgnoredFile(rel)) continue;
    if (ignoredSuffixes.some((suffix) => entry.name.endsWith(suffix))) continue;
    out.push(rel);
  }
  return out;
}

function scanFile(file) {
  const source = readFileSync(path.join(repoRoot, file), 'utf8');
  const findings = [];
  for (const { kind, pattern } of escapePatterns) {
    pattern.lastIndex = 0;
    for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
      findings.push({ file, kind, text: match[0].replace(/\s+/g, ' ') });
    }
  }
  return findings;
}

function findingKey(finding) {
  return `${finding.file}:${finding.kind}:${finding.text}`;
}

function summarize(findings) {
  const counts = new Map();
  for (const finding of findings) {
    const key = findingKey(finding);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

const findings = productionRoots
  .flatMap((root) => walk(path.join(repoRoot, root)))
  .flatMap(scanFile);

if (process.argv.includes('--write-baseline')) {
  process.stdout.write(
    `${JSON.stringify({ version: 2, baseline: summarize(findings) }, null, 2)}\n`,
  );
  process.exit(0);
}

if (!existsSync(baselinePath)) {
  console.error(
    `Missing type escape baseline at ${baselinePath}. Run: node scripts/check-type-escape-ratchet.mjs --write-baseline > scripts/type-escape-baseline.json (writes the current v2 schema).`,
  );
  process.exit(1);
}

const parsed = JSON.parse(readFileSync(baselinePath, 'utf8'));
if (parsed.version !== 2) {
  console.error(
    `Unsupported type escape baseline version ${parsed.version}; this checker expects v2. Regenerate with: node scripts/check-type-escape-ratchet.mjs --write-baseline > scripts/type-escape-baseline.json (writes the current v2 schema).`,
  );
  process.exit(1);
}

const baseline = new Map((parsed.baseline ?? []).map((entry) => [entry.key, entry.count]));
const current = summarize(findings);
const additions = current
  .map((entry) => ({ ...entry, allowed: baseline.get(entry.key) ?? 0 }))
  .filter((entry) => entry.count > entry.allowed);
const stale = [...baseline.keys()].filter((key) => !current.some((entry) => entry.key === key));

if (additions.length > 0) {
  console.error(
    'New production type escape(s) detected. Fix the type boundary instead of adding any/as unknown, or update the documented baseline only for legacy debt.',
  );
  for (const addition of additions.slice(0, 100)) {
    console.error(`  ${addition.key} count ${addition.count} > baseline ${addition.allowed}`);
  }
  if (additions.length > 100) console.error(`  ...and ${additions.length - 100} more`);
  process.exit(1);
}

if (stale.length > 0) {
  console.warn(
    `Type escape ratchet notice: ${stale.length} stale baseline entr${stale.length === 1 ? 'y' : 'ies'} can be pruned with --write-baseline.`,
  );
  for (const key of stale.slice(0, 20)) console.warn(`  stale: ${key}`);
  if (stale.length > 20) console.warn(`  ...and ${stale.length - 20} more`);
  if (process.argv.includes('--strict-stale')) process.exit(1);
}

const total = current.reduce((sum, entry) => sum + entry.count, 0);
console.log(`Type escape ratchet passed (${total} existing production escape(s), 0 new).`);
