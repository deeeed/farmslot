/**
 * Canonical catalog for Farmslot template placeholders.
 * Consumed by scripts/docs/generate-template-variables.mjs.
 * Keep in sync with services/gateway/src/tasks/writer.ts and core/hooks.ts.
 */

/** @typedef {{ name: string; flows: string; description: string; example?: string; empty?: string }} VarRow */

/** @type {VarRow[]} */
export const WORKER_TASK_VARIABLES = [
  {
    name: 'SLOT',
    flows: 'all',
    description: 'Active slot id for this run.',
    example: 'core-1',
  },
  {
    name: 'SLOT_ID',
    flows: 'all',
    description: 'Alias of SLOT (same slot id). Prefer SLOT in new templates.',
    example: 'core-1',
  },
  {
    name: 'TICKET',
    flows: 'all',
    description: 'Primary ticket/PR ref as a plain string (Jira key or owner/repo#N).',
    example: 'PROJ-1234',
  },
  {
    name: 'TICKET_ID',
    flows: 'all',
    description: 'Alias of TICKET for template compatibility.',
    example: 'PROJ-1234',
  },
  {
    name: 'TICKET_URL',
    flows: 'all',
    description: 'Deep link to Jira or GitHub issue when available.',
    example: 'https://jira.example.com/browse/PROJ-1234',
    empty: 'empty string when no URL',
  },
  {
    name: 'TITLE',
    flows: 'all',
    description: 'Ticket or PR title.',
    example: 'Fix null deref in service',
  },
  {
    name: 'TICKET_TITLE',
    flows: 'all',
    description: 'Alias of TITLE.',
    example: 'Fix null deref in service',
  },
  {
    name: 'BRANCH',
    flows: 'all',
    description: 'Git branch the worker should use (tracking branch or PR head).',
    example: 'fix/proj-1234-null-deref',
  },
  {
    name: 'PR_NUMBER',
    flows: 'all (empty unless PR flow)',
    description: 'PR number when the run is PR-bound; otherwise empty.',
    example: '9334',
    empty: "'' for fix-bug/dev",
  },
  {
    name: 'TASK_DIR',
    flows: 'all',
    description: 'Relative task directory under the worker repo (task root + run folder).',
    example: '.task/proj-1234-0402-1430',
  },
  {
    name: 'SESSION',
    flows: 'all',
    description: 'Configured tmux session name for the slot.',
    example: 'core-1',
  },
  {
    name: 'REPO',
    flows: 'all',
    description: 'Slot checkout path (worktree sandbox or primary repo).',
    example: '/Users/me/dev/core',
  },
  {
    name: 'PLATFORM',
    flows: 'all',
    description: 'Slot platform (ios, extension, core, …).',
    example: 'core',
  },
  {
    name: 'ADB_SERIAL',
    flows: 'all',
    description: 'Android adb serial when the slot has one.',
    empty: "'' on non-Android slots",
  },
  {
    name: 'IOS_SIMULATOR',
    flows: 'all',
    description: 'iOS simulator device name when present.',
    empty: "'' on non-iOS slots",
  },
  {
    name: 'WATCHER_PORT',
    flows: 'all',
    description: 'Metro/dev-server port from slot resources.',
    empty: "'' when not configured",
  },
  {
    name: 'CDP_PORT',
    flows: 'all',
    description: 'Chrome CDP port for extension slots.',
    empty: "'' when not configured",
  },
  {
    name: 'RUNTIME_DIR',
    flows: 'all',
    description: 'Project runtime dir from paths.runtime_dir (default .agent).',
    example: '.agent',
  },
  {
    name: 'RECIPE_DIR',
    flows: 'all',
    description: 'Recipe storage dir (paths.recipe_dir or runtime/recipes).',
    example: '.agent/recipes',
  },
  {
    name: 'ARTIFACT_DIR',
    flows: 'all',
    description: 'Project task/artifact root from paths.artifact_dir (default .task).',
    example: '.task',
  },
  {
    name: 'DESCRIPTION',
    flows: 'all',
    description: 'Ticket/PR description markdown.',
    empty: '_No description_',
  },
  {
    name: 'ACCEPTANCE_CRITERIA',
    flows: 'all',
    description: 'Newline-separated AC bullets from ticket fetch.',
    empty: '_Not specified_',
  },
  {
    name: 'AFFECTED_AREA',
    flows: 'all',
    description: 'Affected area field when present.',
    empty: '_Not specified_',
  },
  {
    name: 'SCREENSHOTS',
    flows: 'all',
    description: 'Markdown image list from ticket attachments.',
    empty: '_No screenshots_',
  },
  {
    name: 'COMMENTS',
    flows: 'all',
    description: 'Recent Jira comments as bullet list.',
    empty: '_No comments_',
  },
  {
    name: 'PR_LABELS',
    flows: 'all',
    description: 'Pre-built gh pr create --label flags from project ci.pr_labels.',
    empty: "'' when project defines no labels",
  },
  {
    name: 'PR_TITLE_SUFFIX',
    flows: 'all',
    description: 'Optional suffix for worker-opened PR titles (human-gate projects).',
    empty: "'' when disabled",
  },
  {
    name: 'DEFAULT_BRANCH',
    flows: 'all',
    description: 'Project default branch for gh/git --base.',
    example: 'main',
  },
  {
    name: 'FARMSLOT_DIR',
    flows: 'all',
    description: 'Farmslot repo root (local) or remote agent deploy dir.',
    example: '/Users/me/dev/farmslot',
  },
  {
    name: 'farmslot_dir',
    flows: 'all',
    description: 'Lowercase alias of FARMSLOT_DIR.',
    example: '/Users/me/dev/farmslot',
  },
  {
    name: 'LINKED_TICKETS',
    flows: 'all (review-pr when PR links tickets)',
    description: 'Pre-rendered markdown bullet list of linked Jira keys.',
    empty: '_No linked tickets_',
  },
  {
    name: 'LINKED_DESCRIPTIONS',
    flows: 'all (review-pr when PR links tickets)',
    description: 'Pre-rendered markdown of each linked ticket description.',
    empty: '_No linked tickets_',
  },
  {
    name: 'MOBILE_REPO',
    flows: 'all (when reference_repos.mobile configured)',
    description: 'Resolved path to the mobile reference repo sibling.',
    empty: "'' when not configured",
  },
  {
    name: 'PR_TITLE',
    flows: 'review-pr, pr-complete, merge-main',
    description: 'GitHub PR title.',
    example: 'feat: add terminal market service',
  },
  {
    name: 'PR_BRANCH',
    flows: 'review-pr, pr-complete, merge-main',
    description: 'PR head branch (may differ from tracking BRANCH).',
    example: 'feature/terminal-market',
  },
  {
    name: 'GH_REPO',
    flows: 'review-pr, pr-complete, merge-main',
    description: 'GitHub repo slug owner/name.',
    example: 'MetaMask/core',
  },
  {
    name: 'PR_URL',
    flows: 'review-pr, pr-complete, merge-main',
    description: 'Canonical PR URL.',
    example: 'https://github.com/MetaMask/core/pull/9334',
  },
  {
    name: 'PR_BODY',
    flows: 'review-pr, pr-complete, merge-main',
    description: 'Full PR description markdown.',
    empty: "'' when empty",
  },
  {
    name: 'REVIEW_TIER',
    flows: 'review-pr, pr-complete, merge-main',
    description: 'Review depth tier from dispatch (standard, deep, …).',
    example: 'standard',
  },
  {
    name: 'RECIPE_STRATEGY',
    flows: 'review-pr',
    description: 'Optional recipe validation strategy from dispatch extraVars.',
    empty: "'' when not set",
  },
  {
    name: 'PR_MERGEABLE',
    flows: 'review-pr, pr-complete, merge-main',
    description: 'GitHub mergeable state.',
    example: 'MERGEABLE',
    empty: 'UNKNOWN when fetch failed',
  },
  {
    name: 'PR_MERGE_STATE',
    flows: 'review-pr, pr-complete, merge-main',
    description: 'GitHub mergeStateStatus.',
    example: 'BLOCKED',
    empty: 'UNKNOWN when fetch failed',
  },
  {
    name: 'PR_INTEGRATION_NOTE',
    flows: 'review-pr, pr-complete, merge-main',
    description: 'Human-readable merge/integration summary for reviewers.',
    example:
      'mergeable=MERGEABLE, mergeStateStatus=BLOCKED — merge blocked (often CI or branch protection); review code independently',
  },
  {
    name: 'COMMENT_SUMMARY',
    flows: 'pr-complete',
    description: 'Pre-fetched PR review/issue comments for the worker.',
    empty: 'fallback message when pre-fetch fails',
  },
  {
    name: 'HAS_RECIPE',
    flows: 'pr-complete',
    description: 'Whether artifacts/recipe.json exists in the task dir.',
    example: 'yes',
  },
  {
    name: 'RECIPE_SOURCE',
    flows: 'pr-complete',
    description: 'How the recipe was obtained (family-inherited, pr-body-llm, …).',
    empty: "'' when no recipe",
  },
];

/** @type {VarRow[]} */
export const HOOK_AND_RECIPE_VARIABLES = [
  {
    name: 'port',
    flows: 'hooks, recipe_run, fixtures',
    description: 'Dev-server / Metro port from slot resources.',
    example: '8081',
  },
  {
    name: 'cdp_port',
    flows: 'hooks, recipe_run',
    description: 'Chrome CDP debugging port.',
    example: '9222',
  },
  {
    name: 'simulator',
    flows: 'hooks (ios)',
    description: 'iOS simulator device id/name.',
  },
  {
    name: 'avd',
    flows: 'hooks (android)',
    description: 'Android emulator name.',
  },
  {
    name: 'adb_serial',
    flows: 'hooks, dispatch_cmd',
    description: 'ADB device serial.',
  },
  {
    name: 'headless',
    flows: 'hooks',
    description: 'Headless browser flag when configured.',
  },
  {
    name: 'snapshot',
    flows: 'hooks',
    description: 'Snapshot restore id when configured.',
  },
  {
    name: 'runtime_dir',
    flows: 'hooks, recipe_run',
    description: 'Same as RUNTIME_DIR (lowercase form).',
  },
  {
    name: 'artifact_dir',
    flows: 'hooks, recipe_run',
    description: 'Same as ARTIFACT_DIR (lowercase form).',
  },
  {
    name: 'recipe_dir',
    flows: 'hooks',
    description: 'Same as RECIPE_DIR (lowercase form).',
  },
  {
    name: 'slot_id',
    flows: 'hooks',
    description: 'Same as SLOT_ID (lowercase form).',
  },
  {
    name: 'primary_repo',
    flows: 'hooks',
    description: 'Canonical project tree when slot uses a sandbox worktree.',
  },
  {
    name: 'recipe_path',
    flows: 'recipe_run hook',
    description: 'Selected recipe file for this validation run.',
  },
  {
    name: 'artifacts_dir',
    flows: 'recipe_run hook',
    description: 'Dedicated recipe artifact output directory.',
  },
  {
    name: '<ref>_repo',
    flows: 'hooks (reference_repos)',
    description: 'Resolved path for each project.json reference_repos entry (e.g. mobile_repo).',
  },
  {
    name: 'project.json vars',
    flows: 'hooks + worker TASK',
    description:
      'Arbitrary keys from project.json.vars — expanded once; both key and KEY forms work in hooks.',
    example: 'recipe_runner_resolve_cmd',
  },
];

/** @type {VarRow[]} */
export const DISPATCH_CMD_VARIABLES = [
  { name: 'repo', flows: 'pool dispatch_cmd', description: 'Slot checkout path.' },
  {
    name: 'runner',
    flows: 'pool dispatch_cmd',
    description: 'Selected runner id (claude, codex, …).',
  },
  {
    name: 'runner_path',
    flows: 'pool dispatch_cmd',
    description: 'Resolved CLI path for the runner.',
  },
  {
    name: 'model',
    flows: 'pool dispatch_cmd',
    description: 'Model slug when dispatch specifies one.',
  },
  {
    name: 'task_file',
    flows: 'pool dispatch_cmd',
    description: 'Absolute path to rendered TASK.md.',
  },
  {
    name: 'task_prompt',
    flows: 'pool dispatch_cmd',
    description: 'Optional inline prompt override.',
  },
  {
    name: 'effort',
    flows: 'pool dispatch_cmd',
    description: 'Runner effort/reasoning level when set.',
  },
  {
    name: 'adb_serial',
    flows: 'pool dispatch_cmd',
    description: 'Android serial for mobile dispatch wrappers.',
  },
];

/** @type {VarRow[]} */
export const SECONDARY_TEMPLATE_VARIABLES = [
  {
    name: 'CI_ISSUES',
    flows: 'ci-fix.md',
    description: 'Formatted CI failure / bot comment block for inline fix.',
  },
  {
    name: 'CI_ISSUE_TYPE',
    flows: 'ci-fix.md',
    description: 'comments | failures | both',
  },
  {
    name: 'ISSUES',
    flows: 'self-review-fix.md',
    description: 'Self-review findings list for fix pass.',
  },
  {
    name: 'VALIDATION_DEPTH',
    flows: 'self-review.static-code.md',
    description: 'Depth hint for static validation pass.',
  },
  {
    name: 'TASK_FILE',
    flows: 'worker-dispatch.md nudge',
    description: 'Path to active task file for runner dispatch prompt.',
  },
];
