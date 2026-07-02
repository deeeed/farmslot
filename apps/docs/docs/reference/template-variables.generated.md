---
# GENERATED — scripts/docs/template-variable-catalog.mjs | yarn docs:template-vars
title: Template variables
sidebar_label: Template variables
slug: /reference/template-variables
---

<!-- GENERATED — source: scripts/docs/template-variable-catalog.mjs | yarn docs:template-vars -->

Three placeholder families — do not mix syntax: worker TASK `{{VAR}}` (writer.ts), hooks/recipe `{{var}}` (hooks.ts), pool dispatch `{var}` (slot-common.sh). Extend farms via `project.json` `vars` (both `{{key}}` and `{{KEY}}`).

## TASK format {#task-format}

Gateway progress parsing: `##`+ headings = phases; `- [ ]` / `- [x]` = steps; checkboxes before any heading → **Checklist** phase; fenced blocks and `<details>` skipped; informational sections (acceptance criteria, description, task, …) skipped. `SIGNAL.json` is terminal only — checkboxes carry ongoing progress.

## Worker TASK variables

| Variable                  | Flows                                        | Description                                                             | Example / empty                                                                                                          |
| ------------------------- | -------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `{{SLOT}}`                | all                                          | Active slot id for this run.                                            | core-1                                                                                                                   |
| `{{SLOT_ID}}`             | all                                          | Alias of SLOT (same slot id). Prefer SLOT in new templates.             | core-1                                                                                                                   |
| `{{TICKET}}`              | all                                          | Primary ticket/PR ref as a plain string (Jira key or owner/repo#N).     | PROJ-1234                                                                                                                |
| `{{TICKET_ID}}`           | all                                          | Alias of TICKET for template compatibility.                             | PROJ-1234                                                                                                                |
| `{{TICKET_URL}}`          | all                                          | Deep link to Jira or GitHub issue when available.                       | https://jira.example.com/browse/PROJ-1234                                                                                |
| `{{TITLE}}`               | all                                          | Ticket or PR title.                                                     | Fix null deref in service                                                                                                |
| `{{TICKET_TITLE}}`        | all                                          | Alias of TITLE.                                                         | Fix null deref in service                                                                                                |
| `{{BRANCH}}`              | all                                          | Git branch the worker should use (tracking branch or PR head).          | fix/proj-1234-null-deref                                                                                                 |
| `{{PR_NUMBER}}`           | all (empty unless PR flow)                   | PR number when the run is PR-bound; otherwise empty.                    | 9334                                                                                                                     |
| `{{TASK_DIR}}`            | all                                          | Relative task directory under the worker repo (task root + run folder). | .task/proj-1234-0402-1430                                                                                                |
| `{{SESSION}}`             | all                                          | Configured tmux session name for the slot.                              | core-1                                                                                                                   |
| `{{REPO}}`                | all                                          | Slot checkout path (worktree sandbox or primary repo).                  | /Users/me/dev/core                                                                                                       |
| `{{PLATFORM}}`            | all                                          | Slot platform (ios, extension, core, …).                                | core                                                                                                                     |
| `{{ADB_SERIAL}}`          | all                                          | Android adb serial when the slot has one.                               | empty: '' on non-Android slots                                                                                           |
| `{{IOS_SIMULATOR}}`       | all                                          | iOS simulator device name when present.                                 | empty: '' on non-iOS slots                                                                                               |
| `{{WATCHER_PORT}}`        | all                                          | Metro/dev-server port from slot resources.                              | empty: '' when not configured                                                                                            |
| `{{CDP_PORT}}`            | all                                          | Chrome CDP port for extension slots.                                    | empty: '' when not configured                                                                                            |
| `{{RUNTIME_DIR}}`         | all                                          | Project runtime dir from paths.runtime_dir (default .agent).            | .agent                                                                                                                   |
| `{{RECIPE_DIR}}`          | all                                          | Recipe storage dir (paths.recipe_dir or runtime/recipes).               | .agent/recipes                                                                                                           |
| `{{ARTIFACT_DIR}}`        | all                                          | Project task/artifact root from paths.artifact_dir (default .task).     | .task                                                                                                                    |
| `{{DESCRIPTION}}`         | all                                          | Ticket/PR description markdown.                                         | empty: _No description_                                                                                                  |
| `{{ACCEPTANCE_CRITERIA}}` | all                                          | Newline-separated AC bullets from ticket fetch.                         | empty: _Not specified_                                                                                                   |
| `{{AFFECTED_AREA}}`       | all                                          | Affected area field when present.                                       | empty: _Not specified_                                                                                                   |
| `{{SCREENSHOTS}}`         | all                                          | Markdown image list from ticket attachments.                            | empty: _No screenshots_                                                                                                  |
| `{{COMMENTS}}`            | all                                          | Recent Jira comments as bullet list.                                    | empty: _No comments_                                                                                                     |
| `{{PR_LABELS}}`           | all                                          | Pre-built gh pr create --label flags from project ci.pr_labels.         | empty: '' when project defines no labels                                                                                 |
| `{{PR_TITLE_SUFFIX}}`     | all                                          | Optional suffix for worker-opened PR titles (human-gate projects).      | empty: '' when disabled                                                                                                  |
| `{{DEFAULT_BRANCH}}`      | all                                          | Project default branch for gh/git --base.                               | main                                                                                                                     |
| `{{FARMSLOT_DIR}}`        | all                                          | Farmslot repo root (local) or remote agent deploy dir.                  | /Users/me/dev/farmslot                                                                                                   |
| `{{farmslot_dir}}`        | all                                          | Lowercase alias of FARMSLOT_DIR.                                        | /Users/me/dev/farmslot                                                                                                   |
| `{{LINKED_TICKETS}}`      | all (review-pr when PR links tickets)        | Pre-rendered markdown bullet list of linked Jira keys.                  | empty: _No linked tickets_                                                                                               |
| `{{LINKED_DESCRIPTIONS}}` | all (review-pr when PR links tickets)        | Pre-rendered markdown of each linked ticket description.                | empty: _No linked tickets_                                                                                               |
| `{{MOBILE_REPO}}`         | all (when reference_repos.mobile configured) | Resolved path to the mobile reference repo sibling.                     | empty: '' when not configured                                                                                            |
| `{{PR_TITLE}}`            | review-pr, pr-complete, merge-main           | GitHub PR title.                                                        | feat: add terminal market service                                                                                        |
| `{{PR_BRANCH}}`           | review-pr, pr-complete, merge-main           | PR head branch (may differ from tracking BRANCH).                       | feature/terminal-market                                                                                                  |
| `{{GH_REPO}}`             | review-pr, pr-complete, merge-main           | GitHub repo slug owner/name.                                            | MetaMask/core                                                                                                            |
| `{{PR_URL}}`              | review-pr, pr-complete, merge-main           | Canonical PR URL.                                                       | https://github.com/MetaMask/core/pull/9334                                                                               |
| `{{PR_BODY}}`             | review-pr, pr-complete, merge-main           | Full PR description markdown.                                           | empty: '' when empty                                                                                                     |
| `{{REVIEW_TIER}}`         | review-pr, pr-complete, merge-main           | Review depth tier from dispatch (standard, deep, …).                    | standard                                                                                                                 |
| `{{RECIPE_STRATEGY}}`     | review-pr                                    | Optional recipe validation strategy from dispatch extraVars.            | empty: '' when not set                                                                                                   |
| `{{PR_MERGEABLE}}`        | review-pr, pr-complete, merge-main           | GitHub mergeable state.                                                 | MERGEABLE                                                                                                                |
| `{{PR_MERGE_STATE}}`      | review-pr, pr-complete, merge-main           | GitHub mergeStateStatus.                                                | BLOCKED                                                                                                                  |
| `{{PR_INTEGRATION_NOTE}}` | review-pr, pr-complete, merge-main           | Human-readable merge/integration summary for reviewers.                 | mergeable=MERGEABLE, mergeStateStatus=BLOCKED — merge blocked (often CI or branch protection); review code independently |
| `{{COMMENT_SUMMARY}}`     | pr-complete                                  | Pre-fetched PR review/issue comments for the worker.                    | empty: fallback message when pre-fetch fails                                                                             |
| `{{HAS_RECIPE}}`          | pr-complete                                  | Whether artifacts/recipe.json exists in the task dir.                   | yes                                                                                                                      |
| `{{RECIPE_SOURCE}}`       | pr-complete                                  | How the recipe was obtained (family-inherited, pr-body-llm, …).         | empty: '' when no recipe                                                                                                 |

## Hook / recipe_run variables

| Variable            | Flows                       | Description                                                                                  | Example / empty           |
| ------------------- | --------------------------- | -------------------------------------------------------------------------------------------- | ------------------------- |
| `{{port}}`          | hooks, recipe_run, fixtures | Dev-server / Metro port from slot resources.                                                 | 8081                      |
| `{{cdp_port}}`      | hooks, recipe_run           | Chrome CDP debugging port.                                                                   | 9222                      |
| `{{simulator}}`     | hooks (ios)                 | iOS simulator device id/name.                                                                | —                         |
| `{{avd}}`           | hooks (android)             | Android emulator name.                                                                       | —                         |
| `{{adb_serial}}`    | hooks, dispatch_cmd         | ADB device serial.                                                                           | —                         |
| `{{headless}}`      | hooks                       | Headless browser flag when configured.                                                       | —                         |
| `{{snapshot}}`      | hooks                       | Snapshot restore id when configured.                                                         | —                         |
| `{{runtime_dir}}`   | hooks, recipe_run           | Same as RUNTIME_DIR (lowercase form).                                                        | —                         |
| `{{artifact_dir}}`  | hooks, recipe_run           | Same as ARTIFACT_DIR (lowercase form).                                                       | —                         |
| `{{recipe_dir}}`    | hooks                       | Same as RECIPE_DIR (lowercase form).                                                         | —                         |
| `{{slot_id}}`       | hooks                       | Same as SLOT_ID (lowercase form).                                                            | —                         |
| `{{primary_repo}}`  | hooks                       | Canonical project tree when slot uses a sandbox worktree.                                    | —                         |
| `{{recipe_path}}`   | recipe_run hook             | Selected recipe file for this validation run.                                                | —                         |
| `{{artifacts_dir}}` | recipe_run hook             | Dedicated recipe artifact output directory.                                                  | —                         |
| `<ref>_repo`        | hooks (reference_repos)     | Resolved path for each project.json reference_repos entry (e.g. mobile_repo).                | —                         |
| `project.json vars` | hooks + worker TASK         | Arbitrary keys from project.json.vars — expanded once; both key and KEY forms work in hooks. | recipe_runner_resolve_cmd |

## Pool dispatch_cmd variables

| Placeholder     | Flows             | Description                                  |
| --------------- | ----------------- | -------------------------------------------- |
| `{repo}`        | pool dispatch_cmd | Slot checkout path.                          |
| `{runner}`      | pool dispatch_cmd | Selected runner id (claude, codex, …).       |
| `{runner_path}` | pool dispatch_cmd | Resolved CLI path for the runner.            |
| `{model}`       | pool dispatch_cmd | Model slug when dispatch specifies one.      |
| `{task_file}`   | pool dispatch_cmd | Absolute path to rendered TASK.md.           |
| `{task_prompt}` | pool dispatch_cmd | Optional inline prompt override.             |
| `{effort}`      | pool dispatch_cmd | Runner effort/reasoning level when set.      |
| `{adb_serial}`  | pool dispatch_cmd | Android serial for mobile dispatch wrappers. |

## Secondary in-run templates

| Variable               | Flows                      | Description                                              | Example / empty |
| ---------------------- | -------------------------- | -------------------------------------------------------- | --------------- | ---- | --- |
| `{{CI_ISSUES}}`        | ci-fix.md                  | Formatted CI failure / bot comment block for inline fix. | —               |
| `{{CI_ISSUE_TYPE}}`    | ci-fix.md                  | comments                                                 | failures        | both | —   |
| `{{ISSUES}}`           | self-review-fix.md         | Self-review findings list for fix pass.                  | —               |
| `{{VALIDATION_DEPTH}}` | self-review.static-code.md | Depth hint for static validation pass.                   | —               |
| `{{TASK_FILE}}`        | worker-dispatch.md nudge   | Path to active task file for runner dispatch prompt.     | —               |
