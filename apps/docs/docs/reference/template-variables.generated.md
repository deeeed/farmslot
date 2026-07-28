---
# GENERATED — scripts/docs/template-variable-catalog.mjs | yarn docs:template-vars
title: Template variables
sidebar_label: Template variables
slug: /reference/template-variables
---

<!-- GENERATED — scripts/docs/template-variable-catalog.mjs | yarn docs:template-vars -->

Three families — never mix: worker TASK double-brace vars (writer.ts), hooks/recipe double-brace vars (hooks.ts), pool dispatch single-brace vars (slot-common.sh).

## TASK format {#task-format}

Headings=phases; checkboxes=steps; pre-heading checkboxes=Checklist phase; skip fenced blocks, HTML details blocks, and informational sections (acceptance criteria, description, task, …). SIGNAL.json is terminal only.

## Worker TASK.md (double-brace VAR)

- **all flows:** `SLOT (=SLOT_ID), TICKET (=TICKET_ID), TICKET_URL, TITLE (=TICKET_TITLE), BRANCH, PR_NUMBER (empty unless PR flow), TASK_DIR, SESSION, REPO, PLATFORM, ADB_SERIAL, IOS_SIMULATOR, WATCHER_PORT, CDP_PORT, RUNTIME_DIR, RECIPE_DIR, ARTIFACT_DIR, DESCRIPTION, ACCEPTANCE_CRITERIA, AFFECTED_AREA, SCREENSHOTS, COMMENTS, PR_LABELS, PR_TITLE_SUFFIX, DEFAULT_BRANCH, FARMSLOT_DIR (=farmslot_dir), LINKED_TICKETS, LINKED_DESCRIPTIONS, MOBILE_REPO`
- **review-pr, pr-complete, update-branch:** `PR_NUMBER, PR_TITLE, PR_BRANCH, GH_REPO, PR_URL, PR_BODY, REVIEW_TIER, PR_MERGEABLE, PR_MERGE_STATE, PR_INTEGRATION_NOTE` (PR_INTEGRATION_NOTE is informational merge state; never blocks prepare.)
- **review-pr:** `RECIPE_STRATEGY` (From dispatch extraVars when set.)
- **pr-complete:** `COMMENT_SUMMARY, HAS_RECIPE, RECIPE_SOURCE`
- **update-branch:** `BRANCH_UPDATE_STRATEGY` (rebase | merge | project-default; project-default resolves against force-push policy at runtime.)
- **project.json vars:** `any key` (Both double-brace key forms; expanded once, no nested re-expansion)

## Hooks, fixtures, recipe_run (double-brace var)

- **slot resources:** `port, metro_port, cdp_port, simulator, avd, adb_serial, headless, snapshot, app, platform` (Missing optional resources render empty.)
- **auto-injected:** `runtime_dir, artifact_dir, recipe_dir, farmslot_dir, slot_id, session, repo, primary_repo, recipe_path, artifacts_dir`
- **reference_repos:** `key_repo per entry (e.g. mobile_repo)`
- **project.json vars:** `same as worker TASK extension`

## Pool dispatch_cmd (single-brace var)

- **dispatch_cmd / recycle:** `repo, runner, runner_path, claude_path, codex_path, opencode_path, model, task_file, task_prompt, effort, adb_serial`

## Secondary in-run templates (double-brace VAR)

- **ci-fix.md:** `CI_ISSUES, CI_ISSUE_TYPE + worker/hook vars`
- **self-review-fix.md:** `ISSUES + worker/hook vars`
- **self-review.static-code.md:** `VALIDATION_DEPTH + worker/hook vars`
- **worker-dispatch nudge:** `TASK_FILE, TASK_DIR`
