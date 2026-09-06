// The single changed-file selector shared by the pre-push gate and its tests.
// Mirrors the path filters in .github/workflows/farmslot-quality.yml — do not
// add a second selector elsewhere; extend this table instead.

export const PATH_FILTERS = {
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
    'scripts/quality/check-gateway-api-docs.mjs',
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

// The fast default pre-push lane: the cheap, push-specific meta gates only. It
// deliberately omits repo-wide `format:check` (~40s) and `lint` (~65s) — those
// dominate the wall time and are already covered by pre-commit (eslint --fix +
// prettier on changed files at every commit) and by CI on the PR. Full mode
// (FARMSLOT_FULL_PREPUSH=1) runs the complete `repo` target below.
export const FAST_REPO_STEPS = [
  ['workspace structure', ['yarn', 'quality:structure']],
  ['workspace changelogs', ['yarn', 'quality:changelogs']],
  ['import boundaries', ['yarn', 'quality:imports']],
  ['large-file warning', ['yarn', 'quality:large-files']],
  ['loc advisory', ['yarn', 'quality:loc:advisory']],
];

export const TARGET_STEPS = {
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
  docs: [
    ['docs quality', ['yarn', '--cwd', 'apps/docs', 'quality']],
    ['generated gateway API docs', ['yarn', 'quality:gateway-api-docs']],
  ],
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

// Pre-push must be a fast pass, not a minutes-long CI mirror. By default run only
// the cheap repo-wide meta gates (structure, changelogs, imports, large-file +
// loc advisories — see FAST_REPO_STEPS); repo-wide format/lint and the
// per-workspace `<ws> quality` (typecheck + tests + build) are deferred. Those
// are CI's job (.github/workflows/farmslot-quality.yml runs the same matrix on
// the PR) and the per-workspace tests also carry a known git-isolation leak;
// format/lint are already enforced per-commit on changed files. Opt into the
// full local mirror with FARMSLOT_FULL_PREPUSH=1.
export const FAST_TARGETS = new Set(['repo']);

export function pathMatches(file, pattern) {
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

export function filterMatches(changedFiles, patterns) {
  return changedFiles.some((file) => patterns.some((pattern) => pathMatches(file, pattern)));
}

/**
 * Deterministic target selection for a changed-file set. Declaration order of
 * PATH_FILTERS is the output order, so repeated calls with the same input
 * always produce the same plan.
 */
export function selectTargets(changedFiles, { full = false } = {}) {
  const matched = Object.entries(PATH_FILTERS)
    .filter(([, patterns]) => filterMatches(changedFiles, patterns))
    .map(([target]) => target);
  const active = full ? matched : matched.filter((target) => FAST_TARGETS.has(target));
  const skipped = full ? [] : matched.filter((target) => !FAST_TARGETS.has(target));
  return { matched, active, skipped };
}

/** In fast mode the repo target runs only the cheap meta gates. */
export function stepsForTarget(target, { full = false } = {}) {
  if (!full && target === 'repo') return FAST_REPO_STEPS;
  return TARGET_STEPS[target] ?? [];
}
