# Template variables

Stable reference for `{{placeholder}}` expansion across worker templates, project hooks, and pool dispatch commands.

## Quick links

- [Format conventions](./template-conventions.md) — how TASK.md phases/steps are parsed
- [Generated catalog](./template-variables.generated.md) — full variable tables (regenerate with `yarn docs:template-vars`)
- [Customize worker prompts (docs site)](../../apps/docs/docs/guides/customize-worker-prompts.md) — authoring guide

## Three syntax families

| Family                          | Syntax    | When expanded                            | Configure in                       |
| ------------------------------- | --------- | ---------------------------------------- | ---------------------------------- |
| Worker TASK.md                  | `{{VAR}}` | Dispatch writes TASK.md                  | Template markdown + gateway writer |
| Hooks / fixtures / `recipe_run` | `{{var}}` | Prepare, fixture sync, recipe validation | `project.json` hooks and vars      |
| Pool `dispatch_cmd`             | `{var}`   | Bash worker launch                       | `pool/*.json` slot config          |

Uppercase and lowercase forms are often both accepted for hook vars (`{{repo}}` / `{{REPO}}`). Worker TASK vars are conventionally uppercase.

## Project extension model

Add farm-specific commands without forking the gateway:

```json
{
  "vars": {
    "recipe_runner_resolve_cmd": "node {{farmslot_dir}}/scripts/resolve-runner.mjs",
    "recipe_quality_path": "{{primary_repo}}/scripts/recipe-quality.mjs"
  }
}
```

Each key becomes `{{recipe_runner_resolve_cmd}}` and `{{RECIPE_RUNNER_RESOLVE_CMD}}` in worker templates and hooks. Values are expanded once — nested `{{vars}}` inside `project.json.vars` values are not re-expanded recursively.

## Flow-scoped worker variables

| Flow             | Notable vars beyond the universal set                                             |
| ---------------- | --------------------------------------------------------------------------------- |
| `fix-bug`, `dev` | Ticket fields (`DESCRIPTION`, `ACCEPTANCE_CRITERIA`, …), `BRANCH`, project `vars` |
| `review-pr`      | `PR_*`, `PR_INTEGRATION_NOTE`, `LINKED_TICKETS`, `RECIPE_STRATEGY`, `REVIEW_TIER` |
| `pr-complete`    | PR vars + `COMMENT_SUMMARY`, `HAS_RECIPE`, `RECIPE_SOURCE`                        |
| `merge-main`     | PR vars + merge-focused checklist                                                 |

Universal vars (`TASK_DIR`, `SESSION`, `REPO`, `PLATFORM`, `RUNTIME_DIR`, `FARMSLOT_DIR`, …) apply to every flow. See the generated catalog for the complete list.

## Maintenance

The generated file `template-variables.generated.md` is the exhaustive table. Update `scripts/docs/template-variable-catalog.mjs` when adding gateway-injected vars, then run:

```bash
yarn docs:template-vars
```

CI fails if the generated catalog is stale relative to the catalog source.
