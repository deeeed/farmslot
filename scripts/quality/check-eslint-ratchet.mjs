#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { buildEslintArgs, repoEslintCacheLocation } from './eslint-cache.mjs';

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const commandCenterRequire = createRequire(join(repoRoot, 'apps/command-center/package.json'));
const eslintPackagePath = commandCenterRequire.resolve('eslint/package.json');
const eslintBin = join(dirname(eslintPackagePath), 'bin/eslint.js');
const baselinePath = join(repoRoot, 'scripts/quality/eslint-baseline.json');
const fix = process.argv.includes('--fix');
const writeBaseline = process.argv.includes('--write-baseline');
const strictStale = process.argv.includes('--strict-stale');

function runEslint() {
  const cacheLocation = repoEslintCacheLocation({
    repoRoot,
    eslintPackagePath,
    runtimeVersion: process.version,
  });
  mkdirSync(dirname(cacheLocation), { recursive: true });
  const args = buildEslintArgs({ cacheLocation, fix });
  const result = spawnSync(process.execPath, [eslintBin, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 50,
  });
  if (result.error) throw result.error;
  if (result.signal) {
    process.stderr.write(result.stderr);
    throw new Error(`ESLint terminated by signal ${result.signal}`);
  }
  if ((result.status ?? 0) > 1) {
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    throw new Error(`ESLint failed with fatal status ${result.status}`);
  }
  const output = result.stdout.trim();
  if (!output) {
    process.stderr.write(result.stderr);
    throw new Error('ESLint produced no JSON output; refusing to pass the ratchet silently.');
  }
  try {
    return JSON.parse(output);
  } catch (error) {
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    throw error;
  }
}

function summarize(results) {
  const counts = new Map();
  for (const fileResult of results) {
    const file = relative(repoRoot, fileResult.filePath).split(sep).join('/');
    for (const message of fileResult.messages) {
      const ruleId = message.ruleId ?? 'fatal-parse-error';
      const key = `${file}:${ruleId}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

const current = summarize(runEslint());

if (writeBaseline) {
  process.stdout.write(`${JSON.stringify({ version: 2, baseline: current }, null, 2)}\n`);
  process.exit(0);
}

if (!existsSync(baselinePath)) {
  console.error(
    `Missing ESLint baseline at ${baselinePath}. Run: node scripts/quality/check-eslint-ratchet.mjs --write-baseline > scripts/quality/eslint-baseline.json`,
  );
  process.exit(1);
}

const parsed = JSON.parse(readFileSync(baselinePath, 'utf8'));
if (parsed.version !== 2) {
  console.error(`Unsupported ESLint baseline version ${parsed.version}; expected 2.`);
  process.exit(1);
}

const baseline = new Map((parsed.baseline ?? []).map((entry) => [entry.key, entry.count]));
const additions = current
  .map((entry) => ({ ...entry, allowed: baseline.get(entry.key) ?? 0 }))
  .filter((entry) => entry.count > entry.allowed);

if (additions.length > 0) {
  console.error('New ESLint issue(s) detected. Fix the root cause instead of suppressing rules.');
  for (const addition of additions.slice(0, 100)) {
    console.error(`  ${addition.key} count ${addition.count} > baseline ${addition.allowed}`);
  }
  if (additions.length > 100) console.error(`  ...and ${additions.length - 100} more`);
  process.exit(1);
}

const stale = [...baseline.keys()].filter((key) => !current.some((entry) => entry.key === key));
if (stale.length > 0) {
  console.warn(`ESLint ratchet notice: ${stale.length} stale baseline entries can be pruned.`);
  for (const key of stale.slice(0, 20)) console.warn(`  stale: ${key}`);
  if (stale.length > 20) console.warn(`  ...and ${stale.length - 20} more`);
  if (strictStale) process.exit(1);
}
const total = current.reduce((sum, entry) => sum + entry.count, 0);
console.log(`ESLint ratchet passed (${total} existing issue(s), 0 new).`);
