#!/usr/bin/env node
/**
 * Path-filtered quality gate mirroring .github/workflows/farmslot-quality.yml.
 * Invoked by the git pre-push hook; also runnable manually via `yarn prepush:quality`.
 *
 * Target selection lives in lib/path-filters.mjs — the single changed-file
 * selector shared with scripts/quality/prepush-quality.test.mjs.
 */
import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import { selectTargets, stepsForTarget } from './lib/path-filters.mjs';

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const ZERO_SHA = '0'.repeat(40);

function git(args) {
  const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  return result.stdout.trim();
}

function resolveDefaultBase() {
  for (const candidate of ['@{upstream}', 'origin/main', 'main']) {
    try {
      git(['rev-parse', '--verify', candidate]);
      return candidate;
    } catch {
      // try next
    }
  }
  return 'HEAD~1';
}

function changedFilesForRange(range) {
  if (!range) return [];
  const output = git(['diff', '--name-only', range]);
  return output ? output.split('\n').filter(Boolean) : [];
}

function rangeForPush(localSha, remoteSha) {
  if (!localSha || localSha === ZERO_SHA) return null;
  if (!remoteSha || remoteSha === ZERO_SHA) {
    const base = git(['merge-base', resolveDefaultBase(), localSha]);
    return `${base}..${localSha}`;
  }
  return `${remoteSha}..${localSha}`;
}

function manualPushRange() {
  const localSha = git(['rev-parse', 'HEAD']);
  const base = resolveDefaultBase();
  const mergeBase = git(['merge-base', base, localSha]);
  return [`${mergeBase}..${localSha}`];
}

async function readPushRanges() {
  if (process.stdin.isTTY) {
    return manualPushRange();
  }

  const ranges = [];
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [, localSha, , remoteSha] = trimmed.split(/\s+/);
    const range = rangeForPush(localSha, remoteSha);
    if (range) ranges.push(range);
  }
  return ranges.length > 0 ? ranges : manualPushRange();
}

function runStep(label, command) {
  process.stdout.write(`\n[prepush] ${label}: ${command.join(' ')}\n`);
  const result = spawnSync(command[0], command.slice(1), { cwd: repoRoot, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const ranges = await readPushRanges();
if (ranges.length === 0) {
  console.log('farmslot pre-push: no refs to check; skipping quality gate.');
  process.exit(0);
}

const changedFiles = [...new Set(ranges.flatMap((range) => changedFilesForRange(range)))];
if (changedFiles.length === 0) {
  console.log('farmslot pre-push: no changed files in push range; skipping quality gate.');
  process.exit(0);
}

const full = process.env.FARMSLOT_FULL_PREPUSH === '1';
const { active: activeTargets, skipped: skippedTargets } = selectTargets(changedFiles, { full });

console.log(
  `farmslot pre-push: ${changedFiles.length} changed file(s); running ${activeTargets.length} ${full ? 'full' : 'fast'} quality target(s).`,
);
console.log(`  targets: ${activeTargets.join(', ') || '(none)'}`);
if (!full) {
  console.log('  fast lane: repo-wide format/lint deferred to pre-commit + CI');
}
if (skippedTargets.length > 0) {
  console.log(
    `  deferred to CI (run locally with FARMSLOT_FULL_PREPUSH=1): ${skippedTargets.join(', ')}`,
  );
}
console.log('  skip entirely with: FARMSLOT_SKIP_PREPUSH=1 git push --no-verify');

for (const target of activeTargets) {
  for (const [label, command] of stepsForTarget(target, { full })) {
    runStep(`${target}: ${label}`, command);
  }
}

console.log(
  `\nfarmslot pre-push: ${full ? 'all targeted' : 'fast'} quality gates passed.${
    full ? '' : ' Full typecheck/tests/build run in CI.'
  }`,
);
