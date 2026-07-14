/**
 * Signal-only template placeholder catalog.
 * Source for scripts/docs/generate-template-variables.mjs — keep aligned with
 * writer.ts and hooks.ts when adding gateway-injected vars.
 */

/** @typedef {{ title: string; syntax: string; groups: { scope: string; vars: string; note?: string }[] }} CatalogSection */

/** @type {CatalogSection} */
export const WORKER_TASK = {
  title: 'Worker TASK.md',
  syntax: 'double-brace VAR',
  groups: [
    {
      scope: 'all flows',
      vars: 'SLOT (=SLOT_ID), TICKET (=TICKET_ID), TICKET_URL, TITLE (=TICKET_TITLE), BRANCH, PR_NUMBER (empty unless PR flow), TASK_DIR, SESSION, REPO, PLATFORM, ADB_SERIAL, IOS_SIMULATOR, WATCHER_PORT, CDP_PORT, RUNTIME_DIR, RECIPE_DIR, ARTIFACT_DIR, DESCRIPTION, ACCEPTANCE_CRITERIA, AFFECTED_AREA, SCREENSHOTS, COMMENTS, PR_LABELS, PR_TITLE_SUFFIX, DEFAULT_BRANCH, FARMSLOT_DIR (=farmslot_dir), LINKED_TICKETS, LINKED_DESCRIPTIONS, MOBILE_REPO',
    },
    {
      scope: 'review-pr, pr-complete, update-branch',
      vars: 'PR_NUMBER, PR_TITLE, PR_BRANCH, GH_REPO, PR_URL, PR_BODY, REVIEW_TIER, PR_MERGEABLE, PR_MERGE_STATE, PR_INTEGRATION_NOTE',
      note: 'PR_INTEGRATION_NOTE is informational merge state; never blocks prepare.',
    },
    {
      scope: 'review-pr',
      vars: 'RECIPE_STRATEGY',
      note: 'From dispatch extraVars when set.',
    },
    {
      scope: 'pr-complete',
      vars: 'COMMENT_SUMMARY, HAS_RECIPE, RECIPE_SOURCE',
    },
    {
      scope: 'update-branch',
      vars: 'BRANCH_UPDATE_STRATEGY',
      note: 'rebase | merge | project-default; project-default resolves against force-push policy at runtime.',
    },
    {
      scope: 'project.json vars',
      vars: 'any key',
      note: 'Both double-brace key forms; expanded once, no nested re-expansion',
    },
  ],
};

/** @type {CatalogSection} */
export const HOOKS_AND_RECIPE = {
  title: 'Hooks, fixtures, recipe_run',
  syntax: 'double-brace var',
  groups: [
    {
      scope: 'slot resources',
      vars: 'port, cdp_port, simulator, avd, adb_serial, headless, snapshot, app, platform',
      note: 'Missing optional resources render empty.',
    },
    {
      scope: 'auto-injected',
      vars: 'runtime_dir, artifact_dir, recipe_dir, farmslot_dir, slot_id, session, repo, primary_repo, recipe_path, artifacts_dir',
    },
    {
      scope: 'reference_repos',
      vars: 'key_repo per entry (e.g. mobile_repo)',
    },
    {
      scope: 'project.json vars',
      vars: 'same as worker TASK extension',
    },
  ],
};

/** @type {CatalogSection} */
export const DISPATCH_CMD = {
  title: 'Pool dispatch_cmd',
  syntax: 'single-brace var',
  groups: [
    {
      scope: 'dispatch_cmd / recycle',
      vars: 'repo, runner, runner_path, claude_path, codex_path, opencode_path, model, task_file, task_prompt, effort, adb_serial',
    },
  ],
};

/** @type {CatalogSection} */
export const SECONDARY_TEMPLATES = {
  title: 'Secondary in-run templates',
  syntax: 'double-brace VAR',
  groups: [
    { scope: 'ci-fix.md', vars: 'CI_ISSUES, CI_ISSUE_TYPE + worker/hook vars' },
    { scope: 'self-review-fix.md', vars: 'ISSUES + worker/hook vars' },
    { scope: 'self-review.static-code.md', vars: 'VALIDATION_DEPTH + worker/hook vars' },
    { scope: 'worker-dispatch nudge', vars: 'TASK_FILE, TASK_DIR' },
  ],
};

export const TASK_FORMAT =
  'Headings=phases; checkboxes=steps; pre-heading checkboxes=Checklist phase; skip fenced blocks, HTML details blocks, and informational sections (acceptance criteria, description, task, …). SIGNAL.json is terminal only.';

export const SYNTAX_RULE =
  'Three families — never mix: worker TASK double-brace vars (writer.ts), hooks/recipe double-brace vars (hooks.ts), pool dispatch single-brace vars (slot-common.sh).';
