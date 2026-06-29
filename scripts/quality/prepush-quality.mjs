#!/usr/bin/env node
/**
 * Path-filtered quality gate mirroring .github/workflows/farmslot-quality.yml.
 * Invoked by the git pre-push hook; also runnable manually via `yarn prepush:quality`.
 */
import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const ZERO_SHA = '0'.repeat(40);

const PATH_FILTERS = {
  repo: ['**'],
  command_center: [
    '.github/workflows/farmslot-quality.yml',
    '.prettierrc.json',
    'eslint.config.mjs',
    'package.json',
    'yarn.lock',
    'apps/command-center/**',
    'packages/cli/**',
    'packages/protocol/**',
    'packages/recipe-harness/**',
    'packages/theme/**',
    'services/gateway/**',
    'services/node/**',
  ],
  companion: [
    '.github/workflows/farmslot-quality.yml',
    'package.json',
    'yarn.lock',
    'scripts/quality/check-companion-structure.mjs',
    'apps/companion/**',
    'packages/expo-recipe/**',
    'packages/protocol/**',
    'packages/recipe-harness/**',
    'packages/theme/**',
  ],
  docs: [
    '.github/workflows/farmslot-quality.yml',
    '.github/workflows/docs-quality.yml',
    'package.json',
    'yarn.lock',
    'apps/docs/**',
    'packages/protocol/**',
    'services/gateway/**',
  ],
  cli: [
    '.github/workflows/farmslot-quality.yml',
    'package.json',
    'yarn.lock',
    'packages/cli/**',
    'packages/protocol/**',
    'packages/recipe-harness/**',
  ],
  expo_recipe: [
    '.github/workflows/farmslot-quality.yml',
    'package.json',
    'yarn.lock',
    'packages/expo-recipe/**',
    'packages/protocol/**',
    'packages/recipe-harness/**',
  ],
  protocol: [
    '.github/workflows/farmslot-quality.yml',
    'package.json',
    'yarn.lock',
    'packages/protocol/**',
  ],
  recipe_harness: [
    '.github/workflows/farmslot-quality.yml',
    'package.json',
    'yarn.lock',
    'packages/protocol/**',
    'packages/recipe-harness/**',
  ],
  skills: [
    '.github/workflows/farmslot-quality.yml',
    'package.json',
    'yarn.lock',
    'packages/skills/**',
  ],
  theme: [
    '.github/workflows/farmslot-quality.yml',
    'package.json',
    'yarn.lock',
    'packages/theme/**',
  ],
  gateway: [
    '.github/workflows/farmslot-quality.yml',
    'package.json',
    'yarn.lock',
    'packages/protocol/**',
    'services/gateway/**',
  ],
  node: [
    '.github/workflows/farmslot-quality.yml',
    'package.json',
    'yarn.lock',
    'packages/protocol/**',
    'services/node/**',
  ],
};

const TARGET_STEPS = {
  repo: [
    ['format check', ['yarn', 'format:check']],
    ['eslint ratchet', ['yarn', 'lint']],
    ['workspace structure', ['yarn', 'quality:structure']],
    ['workspace changelogs', ['yarn', 'quality:changelogs']],
    ['import boundaries', ['yarn', 'quality:imports']],
    ['large-file warning', ['yarn', 'quality:large-files']],
    ['loc advisory', ['yarn', 'quality:loc:advisory']],
  ],
  command_center: [
    ['recipe-harness build', ['yarn', 'workspace', '@farmslot/recipe-harness', 'build']],
    ['command-center quality', ['yarn', '--cwd', 'apps/command-center', 'quality']],
  ],
  companion: [['companion quality', ['yarn', '--cwd', 'apps/companion', 'quality']]],
  docs: [['docs quality', ['yarn', '--cwd', 'apps/docs', 'quality']]],
  cli: [['cli quality', ['yarn', 'workspace', '@farmslot/cli', 'quality']]],
  expo_recipe: [['expo-recipe quality', ['yarn', 'workspace', '@farmslot/expo-recipe', 'quality']]],
  protocol: [['protocol quality', ['yarn', 'workspace', '@farmslot/protocol', 'quality']]],
  recipe_harness: [
    ['recipe-harness quality', ['yarn', 'workspace', '@farmslot/recipe-harness', 'quality']],
  ],
  skills: [['skills quality', ['yarn', 'workspace', '@farmslot/skills', 'quality']]],
  theme: [['theme quality', ['yarn', 'workspace', '@farmslot/theme', 'quality']]],
  gateway: [['gateway quality', ['yarn', 'workspace', '@farmslot/gateway', 'quality']]],
  node: [['node quality', ['yarn', 'workspace', '@farmslot/node', 'quality']]],
};

function git(args) {
  const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  return result.stdout.trim();
}

function pathMatches(file, pattern) {
  if (pattern === '**') return true;
  if (pattern.endsWith('/**')) {
    const prefix = pattern.slice(0, -3);
    return file === prefix || file.startsWith(`${prefix}/`);
  }
  const regex = new RegExp(
    `^${pattern.replaceAll('/', '\\/').replaceAll('**', '.*').replaceAll('*', '[^/]*')}$`,
  );
  return regex.test(file);
}

function filterMatches(changedFiles, patterns) {
  return changedFiles.some((file) => patterns.some((pattern) => pathMatches(file, pattern)));
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

const matchedTargets = Object.entries(PATH_FILTERS)
  .filter(([, patterns]) => filterMatches(changedFiles, patterns))
  .map(([target]) => target);

// Pre-push must be a fast pass, not a minutes-long CI mirror. By default run only
// the cheap repo-wide static gates (format, lint, structure, imports, large-file
// + loc advisories). The per-workspace `<ws> quality` targets run full
// typecheck + tests + build — that is CI's job (.github/workflows/farmslot-quality.yml
// runs the same targets on the PR) and it also carries a known test git-isolation
// leak. Opt into the full local mirror with FARMSLOT_FULL_PREPUSH=1.
const FAST_TARGETS = new Set(['repo']);
const full = process.env.FARMSLOT_FULL_PREPUSH === '1';
const activeTargets = full ? matchedTargets : matchedTargets.filter((t) => FAST_TARGETS.has(t));
const skippedTargets = full ? [] : matchedTargets.filter((t) => !FAST_TARGETS.has(t));

console.log(
  `farmslot pre-push: ${changedFiles.length} changed file(s); running ${activeTargets.length} ${full ? 'full' : 'fast'} quality target(s).`,
);
console.log(`  targets: ${activeTargets.join(', ') || '(none)'}`);
if (skippedTargets.length > 0) {
  console.log(
    `  deferred to CI (run locally with FARMSLOT_FULL_PREPUSH=1): ${skippedTargets.join(', ')}`,
  );
}
console.log('  skip entirely with: FARMSLOT_SKIP_PREPUSH=1 git push --no-verify');

for (const target of activeTargets) {
  for (const [label, command] of TARGET_STEPS[target] ?? []) {
    runStep(`${target}: ${label}`, command);
  }
}

console.log(
  `\nfarmslot pre-push: ${full ? 'all targeted' : 'fast'} quality gates passed.${
    full ? '' : ' Full typecheck/tests/build run in CI.'
  }`,
);
