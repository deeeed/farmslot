---
title: Template variables
---

# Template variables

Farmslot expands placeholders when rendering worker TASK files, project hooks, and pool dispatch commands. Use this page when integrating a new farm or customizing worker templates.

## Where to look

| Doc                                                                                                                | Purpose                                     |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| [Template format conventions](https://github.com/deeeed/farmslot/blob/main/docs/reference/template-conventions.md) | TASK.md phase/step parsing rules            |
| [Template variable catalog](./template-variables-catalog.generated)                                                | Full tables — flows, descriptions, examples |
| [Customize worker prompts](../guides/customize-worker-prompts)                                                     | Authoring templates and signal protocol     |

## Three syntax families

Do not mix placeholder syntax across families:

| Family                          | Syntax    | Example                                    |
| ------------------------------- | --------- | ------------------------------------------ |
| Worker TASK.md                  | `{{VAR}}` | `{{TASK_DIR}}/mark complete`               |
| Hooks / fixtures / `recipe_run` | `{{var}}` | `bash {{farmslot_dir}}/setup/preflight.sh` |
| Pool `dispatch_cmd`             | `{var}`   | `{runner_path} --task {task_file}`         |

Worker templates use **uppercase** names by convention. Hook expansion accepts lowercase and uppercase forms for the same slot/project fields.

## Universal worker vars (all flows)

Every dispatched worker task includes at least:

- Identity: `{{TICKET}}`, `{{TICKET_ID}}`, `{{TITLE}}`, `{{BRANCH}}`, `{{SLOT}}`, `{{SLOT_ID}}`
- Paths: `{{TASK_DIR}}`, `{{REPO}}`, `{{RUNTIME_DIR}}`, `{{ARTIFACT_DIR}}`, `{{FARMSLOT_DIR}}`
- Slot: `{{SESSION}}`, `{{PLATFORM}}`, `{{CDP_PORT}}`, `{{WATCHER_PORT}}`
- Ticket body: `{{DESCRIPTION}}`, `{{ACCEPTANCE_CRITERIA}}`, `{{COMMENTS}}`, …

See the [full catalog](./template-variables-catalog.generated) for PR-specific and flow-specific vars.

## PR integration note (`review-pr`)

`{{PR_INTEGRATION_NOTE}}` surfaces GitHub merge state for reviewers. It is **informational** — review prepare does not block on author rebase debt.

Example:

```text
mergeable=MERGEABLE, mergeStateStatus=BLOCKED — merge blocked (often CI or branch protection); review code independently
```

Related: `{{PR_MERGEABLE}}`, `{{PR_MERGE_STATE}}`.

## Extend with `project.json` vars

Farm-specific tool paths belong in project config, not hardcoded in templates:

```json
{
  "vars": {
    "recipe_validate_wrapper": "bash {{primary_repo}}/scripts/validate-recipe.sh"
  }
}
```

Both `{{recipe_validate_wrapper}}` and `{{RECIPE_VALIDATE_WRAPPER}}` resolve in worker templates and hooks.

## Pre-rendered blocks

Templates cannot loop. The gateway pre-renders multi-value ticket data:

- `{{LINKED_TICKETS}}` — bullet list of linked Jira keys
- `{{LINKED_DESCRIPTIONS}}` — full descriptions separated by `---`

Use these in `review-pr` templates instead of inventing per-ticket placeholders.

## Before you merge template changes

```bash
yarn quality:worker-templates projects/<your-farm>
```

For authoring quality (not runtime), see [Worker template quality](./worker-template-quality).
