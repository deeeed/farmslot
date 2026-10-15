'use strict';

const { execFileSync } = require('node:child_process');

const sensitivePaths = [
  [
    'CI/workflow',
    /(^|\/)(\.github|\.circleci|\.buildkite)(\/|$)|(^|\/)(\.gitlab-ci[^/]*|Jenkinsfile|azure-pipelines[^/]*)$/i,
  ],
  [
    'agent/editor configuration',
    /(^|\/)(AGENTS\.md|CLAUDE(?:\.[^/]*)?\.md|\.cursorrules|\.cursor|\.claude|\.agents|\.agent|\.codex|\.vscode|\.idea|\.husky|\.githooks)(\/|$)/i,
  ],
  [
    'dependency/lockfile',
    /(^|\/)(package\.json|(?:package-lock|npm-shrinkwrap)\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.(?:toml|lock)|go\.(?:mod|sum)|Gemfile(?:\.lock)?|Podfile(?:\.lock)?|requirements[^/]*\.txt|poetry\.lock|uv\.lock|pyproject\.toml)$/i,
  ],
  [
    'build/tooling configuration',
    /(^|\/)(?:[^/]*\.config\.[^/]+|tsconfig[^/]*\.json|\.?(?:babelrc|eslintrc|prettierrc)[^/]*|\.tool-versions|Makefile|Dockerfile[^/]*|(?:build|settings)\.gradle(?:\.kts)?|gradle\.properties)$/i,
  ],
];

const REVIEW_DIFF_SCOPE_RULE = [
  '## Diff scope',
  '',
  'Apply this rule in every self-review, review and review-pr, including paired reviews. Compare every changed file in the whole current contribution against the frozen ticket description and acceptance criteria. Each file must serve an AC or a required test for it.',
  'Warm reviews keep correctness checks on their saved delta, but still inventory the whole current contribution for scope. Earlier approval does not authorize extra files. Preserve explicit ticket authorizations; do not infer authorization from a previous reviewer, a passing test or a helpful change.',
  '',
  'BLOCKER unless the ticket explicitly authorizes the change:',
  ...sensitivePaths.map(([category]) => `- ${category}.`),
  '- Repository-wide formatting churn.',
  '',
  'A required test does not by itself authorize a CI job, agent configuration or dependency change. Inspect sensitive-path candidates against the actual ticket; a path match is a review prompt, not proof of authorization or a waiver.',
  'SHOULD-FIX: unrelated refactors, renames or dead-code removal outside the touched area, and new abstractions with one caller.',
  '',
  'The verdict or self-review report must contain a `## Diff scope` section with one row per changed file: `File | Ticket AC or required test | Scope justification or finding`. Identify the source of any explicit authorization. List out-of-scope changes as findings. Any scope BLOCKER requires REQUEST_CHANGES, never APPROVE. For self-review, fix the scope blocker before marking the review complete. Missing ticket scope or an unavailable inventory is unverified, never a clean scope result.',
].join('\n');

function diffScopeCandidates(files) {
  return [...new Set(files)].flatMap((file) =>
    sensitivePaths
      .filter(([, pattern]) => pattern.test(file))
      .map(([category]) => ({ file, category })),
  );
}

function buildDiffScopePacket(files, unavailable) {
  const unique = [...new Set(files)].sort();
  const candidates = diffScopeCandidates(unique);
  return [
    REVIEW_DIFF_SCOPE_RULE,
    '',
    '### Whole-contribution path inventory',
    unavailable ? `UNVERIFIED: ${unavailable}` : JSON.stringify(unique),
    '',
    '### Sensitive-path candidates requiring explicit ticket authorization',
    unavailable ? 'UNVERIFIED' : JSON.stringify(candidates),
    'The path scan cannot detect unrelated refactors, formatting churn or single-caller abstractions. Review the diff for those as well.',
  ].join('\n');
}

function gitDiffScopeFiles(repo, base, head) {
  const git = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  const commit = (ref) =>
    git(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]).trim();
  const baseCommit = commit(base);
  const headCommit = commit(head);
  const mergeBase = git(['merge-base', baseCommit, headCommit]).trim();
  // Disable rename detection so both the removed and added paths are reviewed.
  return git([
    'diff',
    '--no-ext-diff',
    '--no-renames',
    '--name-only',
    '-z',
    mergeBase,
    headCommit,
    '--',
  ])
    .split('\0')
    .filter(Boolean);
}

module.exports = {
  REVIEW_DIFF_SCOPE_RULE,
  diffScopeCandidates,
  buildDiffScopePacket,
  gitDiffScopeFiles,
};

if (require.main === module) {
  const [command, repo, base, head] = process.argv.slice(2);
  if (command === 'instructions') process.stdout.write(`${REVIEW_DIFF_SCOPE_RULE}\n`);
  else if (command === 'packet' && repo && base && head) {
    let files = [];
    let unavailable;
    try {
      files = gitDiffScopeFiles(repo, base, head);
    } catch (error) {
      // Missing source is recorded in the packet; it never becomes a clean scan.
      unavailable = error instanceof Error ? error.message.split('\n')[0] : String(error);
    }
    process.stdout.write(`${buildDiffScopePacket(files, unavailable)}\n`);
  } else
    throw new Error(
      'Usage: review-diff-scope.cjs instructions | packet <repo> <publication-base> <head>',
    );
}
