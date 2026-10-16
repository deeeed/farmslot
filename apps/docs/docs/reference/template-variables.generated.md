---
# GENERATED — scripts/docs/template-variable-catalog.mjs | yarn docs:template-vars
title: Template variables
sidebar_label: Template variables
slug: /reference/template-variables
---

<!-- GENERATED — scripts/docs/template-variable-catalog.mjs | yarn docs:template-vars -->

Three families — never mix: worker TASK double-brace vars (writer.ts), hooks/recipe double-brace vars (hooks.ts), pool dispatch single-brace vars (slot-common.sh).

## TASK format {#task-format}

Headings=phases; checkboxes=steps; pre-heading checkboxes=Checklist phase; skip fenced blocks, HTML details blocks, and informational sections (acceptance criteria, description, task, …). SIGNAL.json is terminal only. The template renders into CHECKLIST.md (the only enumerated file); TASK.md is the generated task document: ticket, acceptance criteria, pointers — never steps (see reference/task-directory-contract).

## Worker TASK.md (double-brace VAR)

- **all flows:** `SLOT (=SLOT_ID), TICKET (=TICKET_ID), TICKET_URL, TITLE (=TICKET_TITLE), BRANCH, PR_NUMBER (empty unless PR flow), TASK_DIR, SESSION, REPO, PLATFORM, ADB_SERIAL, IOS_SIMULATOR, WATCHER_PORT, CDP_PORT, RUNTIME_DIR, RECIPE_DIR, ARTIFACT_DIR, DESCRIPTION, ACCEPTANCE_CRITERIA, AFFECTED_AREA, SCREENSHOTS, COMMENTS, PR_LABELS, PR_TITLE_SUFFIX, DEFAULT_BRANCH, FARMSLOT_DIR (=farmslot_dir), NODE_SUPPORT_DIR (=node_support_dir), LINKED_TICKETS, LINKED_DESCRIPTIONS, MOBILE_REPO`
- **review-pr, pr-complete, update-branch:** `PR_NUMBER, PR_TITLE, PR_BRANCH, GH_REPO, PR_URL, PR_BODY, REVIEW_TIER, PR_MERGEABLE, PR_MERGE_STATE, PR_INTEGRATION_NOTE` (PR_INTEGRATION_NOTE is informational merge state; never blocks prepare.)
- **review-pr:** `RECIPE_STRATEGY` (From dispatch extraVars when set.)
- **pr-complete:** `COMMENT_SUMMARY, HAS_RECIPE, RECIPE_SOURCE`
- **pr-complete, update-branch, inline ci-fix:** `PUBLICATION_BASE, PUBLICATION_PARENT_BASE_SHA, PUBLICATION_PARENT_HEAD_SHA, BRANCH_UPDATE_GUARD_CMD, BRANCH_UPDATE_PUSH_CMD` (The gateway captures stack ownership and the pinned operation in Run persistence. Shared runtime commands perform verified replay and exact-lease push; DEFAULT_BRANCH freshness remains separate.)
- **update-branch:** `BRANCH_UPDATE_STRATEGY` (rebase | merge | project-default; project-default resolves against force-push policy at runtime.)
- **project.json vars:** `any key` (Both double-brace key forms; expanded once, no nested re-expansion)

## Hooks, fixtures, recipe_run (double-brace var)

- **slot resources:** `port, metro_port, cdp_port, simulator, avd, adb_serial, headless, snapshot, app, platform` (Missing optional resources render empty.)
- **auto-injected:** `runtime_dir, artifact_dir, recipe_dir, farmslot_dir, slot_id, session, repo, primary_repo, recipe_path, artifacts_dir`
- **hooks, fixtures:** `node_support_dir` (The slot's selected node-support bundle (ADR-035): the Farmslot checkout for local slots. Pack scripts run from here, never from farmslot_dir on a node.)
- **reference_repos:** `key_repo per entry (e.g. mobile_repo)`
- **project.json vars:** `same as worker TASK extension`

## Pool dispatch_cmd (single-brace var)

- **dispatch_cmd / recycle:** `repo, runner, runner_path, claude_path, codex_path, opencode_path, cursor_path, grok_path, pi_path, model, task_file, task_prompt, effort, adb_serial` (Runner launch templates must use runner_path or the matching runner-specific path placeholder so Farmslot can attach runtime-owned arguments to the executable.)

## Secondary in-run templates (double-brace VAR)

- **ci-fix.md:** `CI_ISSUES, CI_ISSUE_TYPE, PUBLICATION_BASE, BRANCH_UPDATE_INSTRUCTIONS + worker/hook vars` (The shared task-runtime renderer supplies current publication-base rebase and remote-SHA lease instructions, including when TASK.md predates retargeting.)
- **review-fix.md:** `ISSUES, REVIEW_FEEDBACK_FILES + worker/hook vars` (REVIEW_FEEDBACK_FILES is a Markdown list of matching completed reviewer lane feedback paths under TASK_DIR; legacy runs use their retained single feedback path.)
- **review templates, all depths and transports:** `REVIEW_CHECKLIST, REVIEW_SIGNAL, REVIEW_FEEDBACK, VALIDATION_DEPTH + worker/hook vars` (Checklist/signal filenames and feedback path are relative to TASK_DIR and bound to the allocated reviewer context. Use them in explicit mark --checklist/--signal commands. Configured catalog and local templates use the same renderer; original template bytes remain the provenance source. Legacy REVIEW/SELF-REVIEW checklist and signal names are scoped to that lane.)
- **worker-dispatch nudge:** `TASK_FILE, TASK_DIR`
